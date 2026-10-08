import path from "node:path";
import type { Frame, Page, Request } from "playwright";
import {
  RunWriter,
  analyzeStep,
  buildDiagnosis,
  collectFailureContext,
  collectPageScan,
  exportRunOtlp,
  hiddenInstruction,
  inferCausedBy,
  isCrossSite,
  newRunId,
  newStepId,
  truncate,
  MAX_BODY_PREVIEW,
  DEFAULT_RUNS_DIR,
  type FailureDiagnosis,
  type PageScan,
  type Run,
  type RunStatus,
  type Step,
  type StepKind,
} from "@steplight/core/node";
import { BINDING_NAME, installPageListeners, type PageEvent } from "./inject.js";

/** Options for {@link record}. */
export interface RecordOptions {
  /** Human-readable description of what the agent is trying to do. */
  task: string;
  /** Where runs are written. Default: `$STEPLIGHT_DIR` or `.steplight/runs`. */
  dir?: string;
  /** Send the run to an OTLP endpoint on `end()`. Default: only if OTEL_EXPORTER_OTLP_ENDPOINT is set. */
  otel?: boolean;
  /** Extra key/value metadata stored on the run. */
  meta?: Record<string, string>;
}

/** Handle for an in-progress recording. */
export interface RunHandle {
  /** The run id (also the folder name). */
  readonly id: string;
  /** Absolute-or-relative folder the run is written to. */
  readonly dir: string;
  /** Record a note about the agent's reasoning (shown as an `agent_note` step). */
  note(text: string): Promise<void>;
  /**
   * Record a failure the SDK could not see itself (for example from a Locator action) as an
   * `error` step. Pass the selector to also get the "Why did this fail?" analysis.
   * @example try { await page.locator("#x").click() } catch (e) { await run.reportError(e, "#x"); throw e; }
   */
  reportError(error: unknown, selector?: string): Promise<void>;
  /** Finish the run, flush everything to disk, and (optionally) export OTel spans. */
  end(status?: Exclude<RunStatus, "running">): Promise<Run>;
}

/** Delay before a page is scanned a second time to catch text injected after load. */
const RESCAN_DELAY_MS = 1000;

function logError(where: string, err: unknown): void {
  process.stderr.write(`[steplight] ${where}: ${err instanceof Error ? err.message : String(err)}\n`);
}

class Recorder implements RunHandle {
  readonly id = newRunId();
  readonly dir: string;
  private writer!: RunWriter;
  private run: Run;
  private steps: Step[] = [];
  private pages: { url?: string; text: string }[] = [];
  private chain: Promise<void> = Promise.resolve();
  private ended = false;
  private lastNavUrl: string | undefined;
  private readonly seenSelectors = new Set<string>();
  private readonly wrapped: string[] = [];
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();

  constructor(
    private readonly page: Page,
    private readonly options: RecordOptions,
    root: string,
  ) {
    this.dir = path.join(root, this.id);
    this.run = {
      id: this.id,
      task: options.task,
      startedAt: Date.now(),
      status: "running",
      steps: [],
      meta: { ...options.meta },
    };
    this.root = root;
  }
  private readonly root: string;

  /** Queue work so steps are recorded in the order events happened. Never rejects. */
  private enqueue(where: string, job: () => Promise<void>): void {
    this.chain = this.chain.then(job).catch((err) => logError(where, err));
  }

  private async addStep(
    kind: StepKind,
    timestamp: number,
    fields: Partial<Step> = {},
    snapshotText?: string,
  ): Promise<Step> {
    const index = this.steps.length;
    const step: Step = {
      id: newStepId(index),
      runId: this.id,
      index,
      kind,
      timestamp,
      flags: [],
      ...fields,
    };
    step.flags.push(...analyzeStep(step, this.steps, this.pages));
    const cause = inferCausedBy(step, this.steps);
    if (cause) step.causedBy = cause;
    this.steps.push(step);
    await this.writer.addStep(step, snapshotText);
    return step;
  }

  async start(): Promise<void> {
    this.writer = await RunWriter.create(this.root, this.run);
    const page = this.page;

    await page.exposeBinding(BINDING_NAME, (source, event: PageEvent) => {
      if (source.frame !== page.mainFrame()) return;
      const ts = Date.now();
      const url = page.url();
      this.enqueue("event", () => this.onPageEvent(event, ts, url));
    });
    await page.addInitScript(installPageListeners, BINDING_NAME);
    await page.evaluate(installPageListeners, BINDING_NAME).catch(() => undefined);

    page.on("framenavigated", (frame: Frame) => {
      if (frame !== page.mainFrame()) return;
      const ts = Date.now();
      const url = frame.url();
      this.enqueue("navigate", async () => {
        if (url === "about:blank" || url === this.lastNavUrl) return;
        this.lastNavUrl = url;
        await this.addStep("navigate", ts, { url });
      });
    });
    page.on("load", () => {
      const ts = Date.now();
      this.enqueue("page_read", () => this.onLoad(ts));
    });
    page.on("request", (req: Request) => this.onRequest(req));
    page.on("download", (dl) => {
      const ts = Date.now();
      this.enqueue("download", async () => {
        await this.addStep("download", ts, { url: dl.url(), targetText: dl.suggestedFilename() });
      });
    });
    page.on("crash", () => {
      const ts = Date.now();
      this.enqueue("crash", async () => {
        await this.addStep("error", ts, { url: page.url(), targetText: "page crashed" });
      });
    });

    this.wrapActions();

    // Already on a page when recording started: record it too.
    if (page.url() && page.url() !== "about:blank") {
      const ts = Date.now();
      this.enqueue("initial", async () => {
        this.lastNavUrl = page.url();
        await this.addStep("navigate", ts, { url: page.url() });
        await this.onLoad(ts);
      });
    }
  }

  private async onLoad(ts: number): Promise<void> {
    let scan: PageScan;
    try {
      scan = await this.page.evaluate(collectPageScan);
    } catch (err) {
      // The agent navigated away mid-scan: expected and harmless, so stay quiet about it.
      if (!/context was destroyed|navigat|Target (page|closed)/i.test(String(err))) logError("snapshot", err);
      return;
    }
    this.pages.push({ url: scan.url, text: scan.text });
    const flags = hiddenInstruction(scan.dom);
    await this.addStep("page_read", ts, { url: scan.url, targetText: scan.title, flags }, scan.text);
    this.scheduleRescan(scan.url, new Set(flags.map((f) => f.evidence)));
  }

  /** Scan the page again shortly after load: catches instructions injected by scripts (setTimeout). */
  private scheduleRescan(url: string, known: Set<string>): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      if (!this.ended) this.enqueue("rescan", () => this.rescan(url, known));
    }, RESCAN_DELAY_MS);
    timer.unref?.();
    this.timers.add(timer);
  }

  private async rescan(url: string, known: Set<string>): Promise<void> {
    if (this.page.url() !== url) return; // the agent already moved on
    const scan = await this.page.evaluate(collectPageScan);
    const fresh = hiddenInstruction(scan.dom).filter((f) => !known.has(f.evidence));
    if (fresh.length === 0) return;
    this.pages.push({ url: scan.url, text: scan.text });
    await this.addStep(
      "page_read",
      Date.now(),
      { url: scan.url, targetText: `${scan.title} (content changed after load)`, flags: fresh },
      scan.text,
    );
  }

  private onRequest(req: Request): void {
    try {
      const type = req.resourceType();
      if (type !== "fetch" && type !== "xhr") return; // navigations/forms are recorded as navigate/form_submit
      const ts = Date.now();
      const method = req.method();
      const body = req.postData();
      const from = this.page.url();
      this.enqueue("request", async () => {
        await this.addStep("network_request", ts, {
          url: from,
          request: {
            method,
            url: req.url(),
            ...(body ? { bodyPreview: truncate(body, MAX_BODY_PREVIEW) } : {}),
          },
        });
      });
    } catch (err) {
      logError("request", err);
    }
  }

  /**
   * Wrap the page's selector-based action methods so a failed action is recorded together with
   * a diagnosis of why it failed. The original error is always re-thrown unchanged.
   */
  private wrapActions(): void {
    const page = this.page as unknown as Record<string, unknown>;
    const actions: Record<string, StepKind> = {
      click: "click",
      dblclick: "click",
      check: "click",
      uncheck: "click",
      fill: "type",
      type: "type",
      press: "type",
      selectOption: "type",
    };
    for (const [name, kind] of Object.entries(actions)) {
      const original = page[name];
      if (typeof original !== "function") continue;
      page[name] = async (selector: unknown, ...rest: unknown[]) => {
        try {
          return await (original as (...a: unknown[]) => Promise<unknown>).call(this.page, selector, ...rest);
        } catch (err) {
          if (!this.ended && typeof selector === "string") await this.recordFailure(kind, name, selector, err);
          throw err;
        }
      };
      this.wrapped.push(name);
    }
    const goto = page["goto"];
    if (typeof goto === "function") {
      page["goto"] = async (url: unknown, ...rest: unknown[]) => {
        try {
          return await (goto as (...a: unknown[]) => Promise<unknown>).call(this.page, url, ...rest);
        } catch (err) {
          if (!this.ended) await this.reportError(err);
          throw err;
        }
      };
      this.wrapped.push("goto");
    }
  }

  private unwrapActions(): void {
    for (const name of this.wrapped) delete (this.page as unknown as Record<string, unknown>)[name];
    this.wrapped.length = 0;
  }

  /** Diagnose (bounded to 1.5 s) and record a failed action. Never throws. */
  private async recordFailure(kind: StepKind, action: string, selector: string, err: unknown): Promise<void> {
    try {
      const ts = Date.now();
      const url = this.page.url();
      let diagnosis: FailureDiagnosis | undefined;
      try {
        const ctx = await Promise.race([
          this.page.evaluate(collectFailureContext, selector),
          new Promise<undefined>((r) => setTimeout(() => r(undefined), 1500).unref?.()),
        ]);
        if (ctx) diagnosis = buildDiagnosis(ctx, this.seenSelectors.has(selector));
      } catch (e) {
        logError("diagnose", e);
      }
      const message = err instanceof Error ? err.message : String(err);
      this.enqueue("failure", async () => {
        await this.addStep(kind, ts, {
          url,
          targetSelector: selector,
          targetText: `${action} failed`,
          error: message,
          ...(diagnosis ? { diagnosis } : {}),
        });
      });
    } catch (e) {
      logError("recordFailure", e);
    }
  }

  async reportError(error: unknown, selector?: string): Promise<void> {
    try {
      const ts = Date.now();
      let diagnosis: FailureDiagnosis | undefined;
      if (selector) {
        try {
          const ctx = await this.page.evaluate(collectFailureContext, selector);
          diagnosis = buildDiagnosis(ctx, this.seenSelectors.has(selector));
        } catch (e) {
          logError("diagnose", e);
        }
      }
      const message = error instanceof Error ? error.message : String(error);
      this.enqueue("error", async () => {
        await this.addStep("error", ts, {
          url: this.page.url(),
          ...(selector ? { targetSelector: selector } : {}),
          targetText: (message.split("\n")[0] ?? message).slice(0, 200),
          error: message,
          ...(diagnosis ? { diagnosis } : {}),
        });
      });
      await this.chain;
    } catch (e) {
      logError("reportError", e);
    }
  }

  private async onPageEvent(ev: PageEvent, ts: number, url: string): Promise<void> {
    if (ev.selector) this.seenSelectors.add(ev.selector);
    if (ev.type === "click") {
      await this.addStep("click", ts, { url, targetSelector: ev.selector, targetText: ev.text });
    } else if (ev.type === "change") {
      await this.addStep("type", ts, { url, targetSelector: ev.selector, targetText: `${ev.text} (value not recorded)` });
    } else if (ev.type === "submit") {
      const method = ev.method ?? "GET";
      await this.addStep("form_submit", ts, {
        url,
        targetSelector: ev.selector,
        targetText: isCrossSite(url, ev.action) ? "form → other domain" : ev.text,
        request: {
          method,
          url: ev.action ?? url,
          ...(ev.body ? { bodyPreview: truncate(ev.body, MAX_BODY_PREVIEW) } : {}),
        },
      });
    }
  }

  async note(text: string): Promise<void> {
    const ts = Date.now();
    this.enqueue("note", async () => {
      await this.addStep("agent_note", ts, { url: this.page.url(), targetText: text });
    });
    await this.chain;
  }

  async end(status: Exclude<RunStatus, "running"> = "success"): Promise<Run> {
    if (!this.ended) {
      this.ended = true;
      for (const t of this.timers) clearTimeout(t);
      this.timers.clear();
      this.unwrapActions();
      await this.chain;
      const endedAt = Date.now();
      this.run = { ...this.run, status, endedAt, steps: this.steps };
      try {
        await this.writer.finish(status, endedAt);
      } catch (err) {
        logError("finish", err);
      }
      if (this.options.otel ?? Boolean(process.env.OTEL_EXPORTER_OTLP_ENDPOINT)) {
        await exportRunOtlp(this.run);
      }
    }
    return this.run;
  }
}

/**
 * Start recording a Playwright page. Hooks navigation, requests, clicks, field changes and
 * form submits, snapshots every page load, runs the detectors and writes the run to disk.
 * Recording never throws into the agent: internal errors are logged to stderr.
 * @example
 * const run = await record(page, { task: "Book the cheapest flight" });
 * await page.goto("https://example.com");
 * await run.note("Picking the cheapest option");
 * await run.end("success");
 */
export async function record(page: Page, options: RecordOptions): Promise<RunHandle> {
  const root = options.dir ?? process.env.STEPLIGHT_DIR ?? DEFAULT_RUNS_DIR;
  const recorder = new Recorder(page, options, root);
  await recorder.start();
  return recorder;
}
