import { support } from './support';
import { common } from "./common";
import { app } from "./app";
import { auth } from "./auth";
import { nav } from "./nav";
import { time } from "./time";
import { voice } from "./voice";
import { usage } from "./usage";
import { analytics } from "./analytics";
import { gadget } from "./gadget";
import { chat } from "./chat";
import { feed } from "./feed";
import { dispatch } from "./dispatch";
import { workspace } from "./workspace";
import { browser } from "./browser";
import { phone } from "./phone";
import { userBrowser } from "./userBrowser";
import { macTerminal } from "./macTerminal";
import { settings } from "./settings";
import { tasks } from "./tasks";
import { schedules } from "./schedules";
import { vault } from "./vault";
import { knowledge } from "./knowledge";
import { files } from "./files";
import { library } from "./library";
import { clawpages } from "./clawpages";
import { cards } from "./cards";

/** Chinese is the reference language: its shape is the contract every other language matches. */
export const zh = { support, common, app, auth, nav, time, voice, usage, analytics, gadget, chat, feed, dispatch, workspace, browser, phone, userBrowser, macTerminal, settings, tasks, schedules, vault, knowledge, files, library, clawpages, cards };

export type Messages = typeof zh;
