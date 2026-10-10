import { common } from "./common";
import { app } from "./app";
import { auth } from "./auth";
import { nav } from "./nav";
import { time } from "./time";
import { voice } from "./voice";
import { usage } from "./usage";
import { gadget } from "./gadget";
import { chat } from "./chat";
import { feed } from "./feed";
import { dispatch } from "./dispatch";
import { workspace } from "./workspace";
import { browser } from "./browser";
import { phone } from "./phone";
import { settings } from "./settings";
import { tasks } from "./tasks";
import { schedules } from "./schedules";
import { vault } from "./vault";
import { files } from "./files";
import { cards } from "./cards";

/** Chinese is the reference language: its shape is the contract every other language matches. */
export const zh = { common, app, auth, nav, time, voice, usage, gadget, chat, feed, dispatch, workspace, browser, phone, settings, tasks, schedules, vault, files, cards };

export type Messages = typeof zh;
