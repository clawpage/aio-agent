/**
 * What the Mac's browser MCP server (chrome-devtools-mcp 1.10.1 behind
 * bin/user-browser.mjs, its tool whitelist applied) lists, recorded from a live
 * bridge. The gateway answers the tool list from this when the account's Mac is
 * offline, so an executor's aio_mac_native always starts (Codex starts a
 * thread's MCP servers once and never retries a failed one). Refresh it when the
 * bridge's chrome-devtools-mcp version or tool whitelist changes.
 */
export const USER_BROWSER_TOOLS: unknown[] = [
  {
    "name": "click",
    "description": "Clicks on the provided element",
    "inputSchema": {
      "type": "object",
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "properties": {
        "pageId": {
          "type": "number",
          "description": "Targets a specific page by ID."
        },
        "uid": {
          "type": "string",
          "description": "The uid of an element on the page from the page content snapshot"
        },
        "dblClick": {
          "description": "Set to true for double clicks. Default is false.",
          "type": "boolean"
        },
        "includeSnapshot": {
          "description": "Whether to include a snapshot in the response. Default is false.",
          "type": "boolean"
        }
      },
      "required": [
        "pageId",
        "uid"
      ],
      "additionalProperties": {}
    },
    "annotations": {
      "category": "input",
      "readOnlyHint": false
    }
  },
  {
    "name": "close_page",
    "description": "Closes the page by its index. The last open page cannot be closed.",
    "inputSchema": {
      "type": "object",
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "properties": {
        "pageId": {
          "type": "number",
          "description": "The ID of the page to close. Call list_pages to list pages."
        }
      },
      "required": [
        "pageId"
      ],
      "additionalProperties": {}
    },
    "annotations": {
      "category": "navigation",
      "readOnlyHint": false
    }
  },
  {
    "name": "drag",
    "description": "Drag an element onto another element",
    "inputSchema": {
      "type": "object",
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "properties": {
        "pageId": {
          "type": "number",
          "description": "Targets a specific page by ID."
        },
        "from_uid": {
          "type": "string",
          "description": "The uid of the element to drag"
        },
        "to_uid": {
          "type": "string",
          "description": "The uid of the element to drop into"
        },
        "includeSnapshot": {
          "description": "Whether to include a snapshot in the response. Default is false.",
          "type": "boolean"
        }
      },
      "required": [
        "pageId",
        "from_uid",
        "to_uid"
      ],
      "additionalProperties": {}
    },
    "annotations": {
      "category": "input",
      "readOnlyHint": false
    }
  },
  {
    "name": "evaluate_script",
    "description": "Evaluate a JavaScript function inside the target page. Returns the response as JSON, so returned values have to be JSON-serializable.",
    "inputSchema": {
      "type": "object",
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "properties": {
        "pageId": {
          "type": "number",
          "description": "Targets a specific page by ID."
        },
        "function": {
          "type": "string",
          "description": "A JavaScript function declaration to be executed by the tool in the target page.\nExample without arguments: `() => document.title` or `async () => await fetch(\"example.com\")`.\nExample with arguments: `(el) => el.innerText`\n"
        },
        "args": {
          "description": "An optional list of arguments to pass to the function.",
          "type": "array",
          "items": {
            "type": "string",
            "description": "The uid of an element on the page from the page content snapshot"
          }
        },
        "dialogAction": {
          "description": "Handle dialogs while execution. \"accept\", \"dismiss\", or string for response of window.prompt. Defaults to accept.",
          "type": "string"
        },
        "waitForStableDom": {
          "description": "Whether to wait for the DOM to settle. Pass false if the script only reads data. Defaults to true.",
          "type": "boolean"
        }
      },
      "required": [
        "pageId",
        "function"
      ],
      "additionalProperties": {}
    },
    "annotations": {
      "category": "debugging",
      "readOnlyHint": false,
      "conditions": [
        "javascriptEvaluation"
      ]
    }
  },
  {
    "name": "fill",
    "description": "Type text into an input, text area or select an option from a <select> element.",
    "inputSchema": {
      "type": "object",
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "properties": {
        "pageId": {
          "type": "number",
          "description": "Targets a specific page by ID."
        },
        "uid": {
          "type": "string",
          "description": "The uid of an element on the page from the page content snapshot"
        },
        "value": {
          "type": "string",
          "description": "The value to fill in. \"true\" or \"false\" for checkboxes and toggles, \"true\" for radio buttons."
        },
        "includeSnapshot": {
          "description": "Whether to include a snapshot in the response. Default is false.",
          "type": "boolean"
        }
      },
      "required": [
        "pageId",
        "uid",
        "value"
      ],
      "additionalProperties": {}
    },
    "annotations": {
      "category": "input",
      "readOnlyHint": false
    }
  },
  {
    "name": "fill_form",
    "description": "Fill out multiple form elements (inputs, selects, checkboxes, radios) at once. ALWAYS prefer this tool over multiple individual 'fill' or 'click' calls when interacting with forms. It is significantly faster, more reliable, and reduces turn count. Example: Fill username, password, and check \"Remember Me\" in one call.",
    "inputSchema": {
      "type": "object",
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "properties": {
        "pageId": {
          "type": "number",
          "description": "Targets a specific page by ID."
        },
        "elements": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "uid": {
                "type": "string",
                "description": "The uid of the element to fill out"
              },
              "value": {
                "type": "string",
                "description": "Value for the element. \"true\" or \"false\" for checkboxes and toggles, \"true\" for radio buttons."
              }
            },
            "required": [
              "uid",
              "value"
            ],
            "description": "An element to fill out"
          },
          "description": "Elements from snapshot to fill out."
        },
        "includeSnapshot": {
          "description": "Whether to include a snapshot in the response. Default is false.",
          "type": "boolean"
        }
      },
      "required": [
        "pageId",
        "elements"
      ],
      "additionalProperties": {}
    },
    "annotations": {
      "category": "input",
      "readOnlyHint": false
    }
  },
  {
    "name": "get_console_message",
    "description": "Gets a console message by its ID. You can get all messages by calling list_console_messages.",
    "inputSchema": {
      "type": "object",
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "properties": {
        "pageId": {
          "type": "number",
          "description": "Targets a specific page by ID."
        },
        "msgid": {
          "type": "number",
          "description": "The msgid of a console message on the page from the listed console messages"
        }
      },
      "required": [
        "pageId",
        "msgid"
      ],
      "additionalProperties": {}
    },
    "annotations": {
      "category": "debugging",
      "readOnlyHint": true
    }
  },
  {
    "name": "get_network_request",
    "description": "Gets a network request by an optional reqid, if omitted returns the currently selected request in the DevTools Network panel. Useful for inspecting request headers (including 'Cookie') and response headers (including 'Set-Cookie' and directives).",
    "inputSchema": {
      "type": "object",
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "properties": {
        "pageId": {
          "type": "number",
          "description": "Targets a specific page by ID."
        },
        "reqid": {
          "description": "The reqid of the network request. If omitted returns the currently selected request in the DevTools Network panel.",
          "type": "number"
        }
      },
      "required": [
        "pageId"
      ],
      "additionalProperties": {}
    },
    "annotations": {
      "category": "network",
      "readOnlyHint": false
    }
  },
  {
    "name": "handle_dialog",
    "description": "If a browser dialog was opened, use this command to handle it",
    "inputSchema": {
      "type": "object",
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "properties": {
        "pageId": {
          "type": "number",
          "description": "Targets a specific page by ID."
        },
        "action": {
          "type": "string",
          "enum": [
            "accept",
            "dismiss"
          ],
          "description": "Whether to dismiss or accept the dialog"
        },
        "promptText": {
          "description": "Optional prompt text to enter into the dialog.",
          "type": "string"
        }
      },
      "required": [
        "pageId",
        "action"
      ],
      "additionalProperties": {}
    },
    "annotations": {
      "category": "input",
      "readOnlyHint": false
    }
  },
  {
    "name": "hover",
    "description": "Hover over the provided element",
    "inputSchema": {
      "type": "object",
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "properties": {
        "pageId": {
          "type": "number",
          "description": "Targets a specific page by ID."
        },
        "uid": {
          "type": "string",
          "description": "The uid of an element on the page from the page content snapshot"
        },
        "includeSnapshot": {
          "description": "Whether to include a snapshot in the response. Default is false.",
          "type": "boolean"
        }
      },
      "required": [
        "pageId",
        "uid"
      ],
      "additionalProperties": {}
    },
    "annotations": {
      "category": "input",
      "readOnlyHint": false
    }
  },
  {
    "name": "list_console_messages",
    "description": "List all console messages for the target page since the last navigation.",
    "inputSchema": {
      "type": "object",
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "properties": {
        "pageId": {
          "type": "number",
          "description": "Targets a specific page by ID."
        },
        "pageSize": {
          "description": "Maximum number of messages to return. When omitted, returns all messages.",
          "type": "integer",
          "exclusiveMinimum": 0,
          "maximum": 9007199254740991
        },
        "pageIdx": {
          "description": "Page number to return (0-based). When omitted, returns the first page.",
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        "types": {
          "description": "Filter messages to only return messages of the specified resource types. When omitted or empty, returns all messages.",
          "type": "array",
          "items": {
            "type": "string",
            "enum": [
              "log",
              "debug",
              "info",
              "error",
              "warn",
              "dir",
              "dirxml",
              "table",
              "trace",
              "clear",
              "startGroup",
              "startGroupCollapsed",
              "endGroup",
              "assert",
              "profile",
              "profileEnd",
              "count",
              "timeEnd",
              "verbose",
              "issue"
            ]
          }
        },
        "includePreservedMessages": {
          "description": "Set to true to return the preserved messages over the last 3 navigations.",
          "default": false,
          "type": "boolean"
        },
        "includeStackTraces": {
          "description": "Set to true to include the stack trace for each message when available. Increases the response size.",
          "default": false,
          "type": "boolean"
        },
        "serviceWorkerId": {
          "description": "Filter messages to only return messages of the specified service worker.",
          "type": "string"
        }
      },
      "required": [
        "pageId"
      ],
      "additionalProperties": {}
    },
    "annotations": {
      "category": "debugging",
      "readOnlyHint": true
    }
  },
  {
    "name": "list_network_requests",
    "description": "Lists the most recent requests for the target page since the last navigation.",
    "inputSchema": {
      "type": "object",
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "properties": {
        "pageId": {
          "type": "number",
          "description": "Targets a specific page by ID."
        },
        "pageSize": {
          "description": "Maximum number of requests to return. When omitted, returns all requests.",
          "type": "integer",
          "exclusiveMinimum": 0,
          "maximum": 9007199254740991
        },
        "pageIdx": {
          "description": "Page number to return (0-based). When omitted, returns the first page.",
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        "resourceTypes": {
          "description": "Filter requests to only return requests of the specified resource types. When omitted or empty, returns all requests.",
          "type": "array",
          "items": {
            "type": "string",
            "enum": [
              "document",
              "stylesheet",
              "image",
              "media",
              "font",
              "script",
              "texttrack",
              "xhr",
              "fetch",
              "prefetch",
              "eventsource",
              "websocket",
              "manifest",
              "signedexchange",
              "ping",
              "cspviolationreport",
              "preflight",
              "fedcm",
              "other"
            ]
          }
        },
        "includePreservedRequests": {
          "description": "Set to true to return the preserved requests over the last 3 navigations.",
          "default": false,
          "type": "boolean"
        }
      },
      "required": [
        "pageId"
      ],
      "additionalProperties": {}
    },
    "annotations": {
      "category": "network",
      "readOnlyHint": true
    }
  },
  {
    "name": "list_pages",
    "description": "Get a list of pages open in the browser.",
    "inputSchema": {
      "type": "object",
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "properties": {},
      "additionalProperties": {}
    },
    "annotations": {
      "category": "navigation",
      "readOnlyHint": true
    }
  },
  {
    "name": "navigate_page",
    "description": "Go to a URL, or back, forward, or reload. Use project URL if not specified otherwise.",
    "inputSchema": {
      "type": "object",
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "properties": {
        "pageId": {
          "type": "number",
          "description": "Targets a specific page by ID."
        },
        "type": {
          "description": "Navigate the page by URL, back or forward in history, or reload.",
          "type": "string",
          "enum": [
            "url",
            "back",
            "forward",
            "reload"
          ]
        },
        "url": {
          "description": "Target URL (only type=url)",
          "type": "string"
        },
        "ignoreCache": {
          "description": "Whether to ignore cache on reload.",
          "type": "boolean"
        },
        "handleBeforeUnload": {
          "description": "Whether to auto accept or beforeunload dialogs triggered by this navigation. Default is accept.",
          "type": "string",
          "enum": [
            "accept",
            "dismiss"
          ]
        },
        "initScript": {
          "description": "A JavaScript script to be executed on each new document before any other scripts for the next navigation.",
          "type": "string"
        },
        "timeout": {
          "description": "Maximum wait time in milliseconds. If set to 0, the default timeout will be used.",
          "type": "integer",
          "minimum": -9007199254740991,
          "maximum": 9007199254740991
        }
      },
      "required": [
        "pageId"
      ],
      "additionalProperties": {}
    },
    "annotations": {
      "category": "navigation",
      "readOnlyHint": false
    }
  },
  {
    "name": "new_page",
    "description": "Open a new tab and load a URL. Use project URL if not specified otherwise.",
    "inputSchema": {
      "type": "object",
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "properties": {
        "url": {
          "type": "string",
          "description": "URL to load in a new page."
        },
        "timeout": {
          "description": "Maximum wait time in milliseconds. If set to 0, the default timeout will be used.",
          "type": "integer",
          "minimum": -9007199254740991,
          "maximum": 9007199254740991
        }
      },
      "required": [
        "url"
      ],
      "additionalProperties": {}
    },
    "annotations": {
      "category": "navigation",
      "readOnlyHint": false
    }
  },
  {
    "name": "press_key",
    "description": "Press a key or key combination. Use this when other input methods like fill() cannot be used (e.g., keyboard shortcuts, navigation keys, or special key combinations).",
    "inputSchema": {
      "type": "object",
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "properties": {
        "pageId": {
          "type": "number",
          "description": "Targets a specific page by ID."
        },
        "key": {
          "type": "string",
          "description": "A key or a combination (e.g., \"Enter\", \"Control+A\", \"Control++\", \"Control+Shift+R\"). Modifiers: Control, Shift, Alt, Meta"
        },
        "includeSnapshot": {
          "description": "Whether to include a snapshot in the response. Default is false.",
          "type": "boolean"
        }
      },
      "required": [
        "pageId",
        "key"
      ],
      "additionalProperties": {}
    },
    "annotations": {
      "category": "input",
      "readOnlyHint": false
    }
  },
  {
    "name": "select_page",
    "description": "Select a page as a context for future tool calls.",
    "inputSchema": {
      "type": "object",
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "properties": {
        "pageId": {
          "type": "number",
          "description": "The ID of the page to select. Call list_pages to get available pages."
        },
        "bringToFront": {
          "description": "Whether to focus the page and bring it to the top.",
          "type": "boolean"
        }
      },
      "required": [
        "pageId"
      ],
      "additionalProperties": {}
    },
    "annotations": {
      "category": "navigation",
      "readOnlyHint": true
    }
  },
  {
    "name": "take_screenshot",
    "description": "Take a screenshot of the page or element.",
    "inputSchema": {
      "type": "object",
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "properties": {
        "pageId": {
          "type": "number",
          "description": "Targets a specific page by ID."
        },
        "format": {
          "default": "png",
          "description": "Type of format to save the screenshot as. Default is \"png\"",
          "type": "string",
          "enum": [
            "png",
            "jpeg",
            "webp"
          ]
        },
        "quality": {
          "description": "Compression quality for JPEG and WebP formats (0-100). Higher values mean better quality but larger file sizes. Ignored for PNG format.",
          "type": "number",
          "minimum": 0,
          "maximum": 100
        },
        "uid": {
          "description": "The uid of an element on the page from the page content snapshot. If omitted, takes a page screenshot.",
          "type": "string"
        },
        "fullPage": {
          "description": "If set to true takes a screenshot of the full page instead of the currently visible viewport. Incompatible with uid.",
          "type": "boolean"
        }
      },
      "required": [
        "pageId"
      ],
      "additionalProperties": {}
    },
    "annotations": {
      "category": "debugging",
      "readOnlyHint": false
    }
  },
  {
    "name": "take_snapshot",
    "description": "Take a text snapshot of the target page based on the a11y tree. The snapshot lists page elements along with a unique\nidentifier (uid). Always use the latest snapshot. Prefer taking a snapshot over taking a screenshot. The snapshot indicates the element selected\nin the DevTools Elements panel (if any).",
    "inputSchema": {
      "type": "object",
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "properties": {
        "pageId": {
          "type": "number",
          "description": "Targets a specific page by ID."
        },
        "verbose": {
          "description": "Whether to include all possible information available in the full a11y tree. Default is false.",
          "type": "boolean"
        }
      },
      "required": [
        "pageId"
      ],
      "additionalProperties": {}
    },
    "annotations": {
      "category": "debugging",
      "readOnlyHint": false
    }
  },
  {
    "name": "type_text",
    "description": "Type text using keyboard into a previously focused input",
    "inputSchema": {
      "type": "object",
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "properties": {
        "pageId": {
          "type": "number",
          "description": "Targets a specific page by ID."
        },
        "text": {
          "type": "string",
          "description": "The text to type"
        },
        "submitKey": {
          "description": "Optional key to press after typing. E.g., \"Enter\", \"Tab\", \"Escape\"",
          "type": "string"
        }
      },
      "required": [
        "pageId",
        "text"
      ],
      "additionalProperties": {}
    },
    "annotations": {
      "category": "input",
      "readOnlyHint": false
    }
  },
  {
    "name": "wait_for",
    "description": "Wait for the specified text to appear on the selected page.",
    "inputSchema": {
      "type": "object",
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "properties": {
        "pageId": {
          "type": "number",
          "description": "Targets a specific page by ID."
        },
        "text": {
          "minItems": 1,
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Non-empty list of texts. Resolves when any value appears on the page."
        },
        "timeout": {
          "description": "Maximum wait time in milliseconds. If set to 0, the default timeout will be used.",
          "type": "integer",
          "minimum": -9007199254740991,
          "maximum": 9007199254740991
        }
      },
      "required": [
        "pageId",
        "text"
      ],
      "additionalProperties": {}
    },
    "annotations": {
      "category": "navigation",
      "readOnlyHint": true
    }
  }
];
