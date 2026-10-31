import { http } from "./http.js";
import { tasks } from "./tasks.js";
import { documents } from "./documents.js";
import { browser } from "./browser.js";
import { agent } from "./agent.js";
import { sandbox } from "./sandbox.js";
import { knowledge } from "./knowledge.js";

/** Chinese is the reference language: its shape is the contract every other language matches. */
export const zh = { http, tasks, documents, browser, agent, sandbox, knowledge };

export type Messages = typeof zh;
