import type { Messages } from "../zh/index.js";
import { http } from "./http.js";
import { tasks } from "./tasks.js";
import { documents } from "./documents.js";
import { browser } from "./browser.js";
import { agent } from "./agent.js";
import { sandbox } from "./sandbox.js";
import { knowledge } from "./knowledge.js";

export const en: Messages = { http, tasks, documents, browser, agent, sandbox, knowledge };
