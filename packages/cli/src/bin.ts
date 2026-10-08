#!/usr/bin/env node
import { buildProgram } from "./index.js";

void buildProgram().parseAsync(process.argv);
