import { main } from "./main.js";

// The bundle is CommonJS (the public repository has no package.json), so no top-level await.
void main(process.env).then((code) => {
  process.exitCode = code;
});
