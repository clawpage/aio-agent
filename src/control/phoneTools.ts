/**
 * What the phone's MCP server (mobile-mcp 1.0.9 behind bin/phone-bridge.mjs, its
 * tool whitelist applied) says about itself, recorded from a live bridge. The
 * gateway answers the handshake and the tool list from this when the account's
 * Mac is offline, so an executor's aio_mac_native always starts (Codex starts a
 * thread's MCP servers once and never retries a failed one). Refresh it when
 * the bridge's mobile-mcp version or tool whitelist changes.
 */
export const PHONE_SERVER = {
  "serverInfo": {
    "name": "mobile-mcp",
    "version": "1.0.9"
  },
  "instructions": "Drive a real or simulated iOS/Android device.\n\nStart with mobile_list_available_devices and pass the chosen device id to every\nlater call - there is no implicit \"current device\". Use a remote device only\nwhen local ones do not fit or when requested by the user. Remote devices cost\nmoney and take time to allocate and release. Release when done using, so the\nremote device cleans and returns to pool.\n\nRead the screen with mobile_list_elements_on_screen, not screenshots: it returns\nrefs, coordinates and labels, and tapping by ref survives layout differences\nbetween devices. Fall back to mobile_take_screenshot only for elements missing\nfrom the hierarchy, or to judge visual appearance.\n\nEach call is a device round-trip. Group known sequences (tap, type, tap) into\nmobile_batch_commands instead of issuing them one at a time.\n\nPrefer mobile_launch_app to open an app, and mobile_open_url to open a web page,\nover navigating through the UI. mobile_open_url only accepts http:// and\nhttps:// URLs unless the server was started with MOBILEMCP_ALLOW_UNSAFE_URLS=1,\nso do not rely on it for app deep links."
} as const;

export const PHONE_TOOLS: unknown[] = [
  {
    "name": "mobile_list_available_devices",
    "title": "List Devices",
    "description": "List all available devices. This includes both physical mobile devices and mobile simulators and emulators. It returns both Android and iOS devices. These are local devices already connected to this machine, ready to use immediately at no cost - for devices from the shared remote cloud fleet, use mobile_list_remote_devices instead.",
    "inputSchema": {
      "type": "object",
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "properties": {}
    },
    "annotations": {
      "readOnlyHint": true,
      "openWorldHint": false
    }
  },
  {
    "name": "mobile_list_apps",
    "title": "List Apps",
    "description": "List all the installed apps on the device",
    "inputSchema": {
      "type": "object",
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "properties": {
        "device": {
          "type": "string",
          "description": "The device identifier to use. Use mobile_list_available_devices to find which devices are available to you."
        }
      },
      "required": [
        "device"
      ]
    },
    "annotations": {
      "readOnlyHint": true,
      "openWorldHint": false
    }
  },
  {
    "name": "mobile_get_foreground_app",
    "title": "Get Foreground App",
    "description": "Get the app currently in the foreground on the device. Use this to verify which app or screen you are on before interacting with it.",
    "inputSchema": {
      "type": "object",
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "properties": {
        "device": {
          "type": "string",
          "description": "The device identifier to use. Use mobile_list_available_devices to find which devices are available to you."
        }
      },
      "required": [
        "device"
      ]
    },
    "annotations": {
      "readOnlyHint": true,
      "openWorldHint": false
    }
  },
  {
    "name": "mobile_launch_app",
    "title": "Launch App",
    "description": "Launch an app on mobile device. Use this to open a specific app. You can find the package name of the app by calling mobile_list_apps.",
    "inputSchema": {
      "type": "object",
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "properties": {
        "device": {
          "type": "string",
          "description": "The device identifier to use. Use mobile_list_available_devices to find which devices are available to you."
        },
        "packageName": {
          "type": "string",
          "description": "The package name of the app to launch"
        },
        "locale": {
          "description": "Comma-separated BCP 47 locale tags to launch the app with (e.g., fr-FR,en-GB)",
          "type": "string"
        }
      },
      "required": [
        "device",
        "packageName"
      ]
    },
    "annotations": {
      "readOnlyHint": false,
      "destructiveHint": false,
      "openWorldHint": true
    }
  },
  {
    "name": "mobile_terminate_app",
    "title": "Terminate App",
    "description": "Stop and terminate an app on mobile device",
    "inputSchema": {
      "type": "object",
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "properties": {
        "device": {
          "type": "string",
          "description": "The device identifier to use. Use mobile_list_available_devices to find which devices are available to you."
        },
        "packageName": {
          "type": "string",
          "description": "The package name of the app to terminate"
        }
      },
      "required": [
        "device",
        "packageName"
      ]
    },
    "annotations": {
      "readOnlyHint": false,
      "destructiveHint": false,
      "openWorldHint": false
    }
  },
  {
    "name": "mobile_get_screen_size",
    "title": "Get Screen Size",
    "description": "Get the screen size of the mobile device in pixels",
    "inputSchema": {
      "type": "object",
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "properties": {
        "device": {
          "type": "string",
          "description": "The device identifier to use. Use mobile_list_available_devices to find which devices are available to you."
        }
      },
      "required": [
        "device"
      ]
    },
    "annotations": {
      "readOnlyHint": true,
      "openWorldHint": false
    }
  },
  {
    "name": "mobile_click_on_screen_at_coordinates",
    "title": "Click Screen",
    "description": "Click on the screen, either at x,y coordinates or on an element by its ref (e.g. \"@e5\") from the latest mobile_list_elements_on_screen result. Prefer ref when the element is listed.",
    "inputSchema": {
      "type": "object",
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "properties": {
        "device": {
          "type": "string",
          "description": "The device identifier to use. Use mobile_list_available_devices to find which devices are available to you."
        },
        "x": {
          "description": "The x coordinate to click on the screen, in pixels. Required unless ref is given",
          "type": "number",
          "minimum": 0
        },
        "y": {
          "description": "The y coordinate to click on the screen, in pixels. Required unless ref is given",
          "type": "number",
          "minimum": 0
        },
        "ref": {
          "description": "Element ref from mobile_list_elements_on_screen, e.g. \"@e5\". Takes precedence over x,y",
          "type": "string"
        }
      },
      "required": [
        "device"
      ]
    },
    "annotations": {
      "readOnlyHint": false,
      "destructiveHint": false,
      "openWorldHint": true
    }
  },
  {
    "name": "mobile_double_tap_on_screen",
    "title": "Double Tap Screen",
    "description": "Double-tap on the screen, either at x,y coordinates or on an element by its ref (e.g. \"@e5\") from the latest mobile_list_elements_on_screen result. Prefer ref when the element is listed.",
    "inputSchema": {
      "type": "object",
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "properties": {
        "device": {
          "type": "string",
          "description": "The device identifier to use. Use mobile_list_available_devices to find which devices are available to you."
        },
        "x": {
          "description": "The x coordinate to double-tap, in pixels. Required unless ref is given",
          "type": "number",
          "minimum": 0
        },
        "y": {
          "description": "The y coordinate to double-tap, in pixels. Required unless ref is given",
          "type": "number",
          "minimum": 0
        },
        "ref": {
          "description": "Element ref from mobile_list_elements_on_screen, e.g. \"@e5\". Takes precedence over x,y",
          "type": "string"
        }
      },
      "required": [
        "device"
      ]
    },
    "annotations": {
      "readOnlyHint": false,
      "destructiveHint": false,
      "openWorldHint": true
    }
  },
  {
    "name": "mobile_long_press_on_screen_at_coordinates",
    "title": "Long Press Screen",
    "description": "Long press on the screen, either at x,y coordinates or on an element by its ref (e.g. \"@e5\") from the latest mobile_list_elements_on_screen result. Prefer ref when the element is listed.",
    "inputSchema": {
      "type": "object",
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "properties": {
        "device": {
          "type": "string",
          "description": "The device identifier to use. Use mobile_list_available_devices to find which devices are available to you."
        },
        "x": {
          "description": "The x coordinate to long press on the screen, in pixels. Required unless ref is given",
          "type": "number",
          "minimum": 0
        },
        "y": {
          "description": "The y coordinate to long press on the screen, in pixels. Required unless ref is given",
          "type": "number",
          "minimum": 0
        },
        "ref": {
          "description": "Element ref from mobile_list_elements_on_screen, e.g. \"@e5\". Takes precedence over x,y",
          "type": "string"
        },
        "duration": {
          "description": "Duration of the long press in milliseconds. Defaults to 500ms.",
          "type": "number",
          "minimum": 1,
          "maximum": 10000
        }
      },
      "required": [
        "device"
      ]
    },
    "annotations": {
      "readOnlyHint": false,
      "destructiveHint": false,
      "openWorldHint": true
    }
  },
  {
    "name": "mobile_list_elements_on_screen",
    "title": "List Screen Elements",
    "description": "List elements on screen with their ref, coordinates, and display text or accessibility label. Use the ref with mobile_click_on_screen_at_coordinates, mobile_double_tap_on_screen or mobile_long_press_on_screen_at_coordinates. Refs and coordinates stay valid as long as the screen does not change; re-list only after navigation or a layout change.",
    "inputSchema": {
      "type": "object",
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "properties": {
        "device": {
          "type": "string",
          "description": "The device identifier to use. Use mobile_list_available_devices to find which devices are available to you."
        },
        "format": {
          "description": "Output format. \"text\" (default) is one compact line per element, \"json\" is a json array",
          "type": "string",
          "enum": [
            "text",
            "json"
          ]
        }
      },
      "required": [
        "device"
      ]
    },
    "annotations": {
      "readOnlyHint": true,
      "openWorldHint": true
    }
  },
  {
    "name": "mobile_press_button",
    "title": "Press Button",
    "description": "Press a button on device",
    "inputSchema": {
      "type": "object",
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "properties": {
        "device": {
          "type": "string",
          "description": "The device identifier to use. Use mobile_list_available_devices to find which devices are available to you."
        },
        "button": {
          "type": "string",
          "description": "The button to press. Supported buttons: BACK (android only), HOME, VOLUME_UP, VOLUME_DOWN, ENTER, DPAD_CENTER (android tv only), DPAD_UP (android tv only), DPAD_DOWN (android tv only), DPAD_LEFT (android tv only), DPAD_RIGHT (android tv only)"
        }
      },
      "required": [
        "device",
        "button"
      ]
    },
    "annotations": {
      "readOnlyHint": false,
      "destructiveHint": false,
      "openWorldHint": true
    }
  },
  {
    "name": "mobile_open_url",
    "title": "Open URL",
    "description": "Open an http:// or https:// URL in the browser on device. Other URL schemes, such as app deep links, are rejected unless the server was started with MOBILEMCP_ALLOW_UNSAFE_URLS=1.",
    "inputSchema": {
      "type": "object",
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "properties": {
        "device": {
          "type": "string",
          "description": "The device identifier to use. Use mobile_list_available_devices to find which devices are available to you."
        },
        "url": {
          "type": "string",
          "description": "The URL to open, starting with http:// or https://"
        }
      },
      "required": [
        "device",
        "url"
      ]
    },
    "annotations": {
      "readOnlyHint": false,
      "destructiveHint": false,
      "openWorldHint": true
    }
  },
  {
    "name": "mobile_swipe_on_screen",
    "title": "Swipe Screen",
    "description": "Swipe on the screen",
    "inputSchema": {
      "type": "object",
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "properties": {
        "device": {
          "type": "string",
          "description": "The device identifier to use. Use mobile_list_available_devices to find which devices are available to you."
        },
        "direction": {
          "type": "string",
          "enum": [
            "up",
            "down",
            "left",
            "right"
          ],
          "description": "The direction to swipe"
        },
        "x": {
          "description": "The x coordinate to start the swipe from, in pixels. If not provided, uses center of screen",
          "type": "number",
          "minimum": 0
        },
        "y": {
          "description": "The y coordinate to start the swipe from, in pixels. If not provided, uses center of screen",
          "type": "number",
          "minimum": 0
        },
        "distance": {
          "description": "The distance to swipe in pixels. Defaults to 400 pixels for iOS or 30% of screen dimension for Android",
          "type": "number"
        }
      },
      "required": [
        "device",
        "direction"
      ]
    },
    "annotations": {
      "readOnlyHint": false,
      "destructiveHint": false,
      "openWorldHint": true
    }
  },
  {
    "name": "mobile_type_keys",
    "title": "Type Text",
    "description": "Type text into the focused element",
    "inputSchema": {
      "type": "object",
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "properties": {
        "device": {
          "type": "string",
          "description": "The device identifier to use. Use mobile_list_available_devices to find which devices are available to you."
        },
        "text": {
          "type": "string",
          "description": "The text to type"
        },
        "submit": {
          "description": "Whether to submit the text. If true, the text will be submitted as if the user pressed the enter key. Defaults to false",
          "type": "boolean"
        }
      },
      "required": [
        "device",
        "text"
      ]
    },
    "annotations": {
      "readOnlyHint": false,
      "destructiveHint": false,
      "openWorldHint": true
    }
  },
  {
    "name": "mobile_take_screenshot",
    "title": "Take Screenshot",
    "description": "Take a screenshot of the mobile device. Use this to understand what's on screen, if you need to press an element that is available through view hierarchy then you must list elements on screen instead. The screenshot is usually smaller than the screen, so when the device reports its screen size the result also states how to convert positions in the screenshot into screen coordinates before tapping. Do not cache this result.",
    "inputSchema": {
      "type": "object",
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "properties": {
        "device": {
          "type": "string",
          "description": "The device identifier to use. Use mobile_list_available_devices to find which devices are available to you."
        },
        "maxSize": {
          "description": "Maximum width/height in pixels, keeping aspect ratio. Defaults to 1024.",
          "type": "integer",
          "exclusiveMinimum": 0,
          "maximum": 9007199254740991
        },
        "scale": {
          "description": "Scale factor (0.0-1.0). Ignored if maxSize is provided.",
          "type": "number",
          "exclusiveMinimum": 0,
          "maximum": 1
        }
      },
      "required": [
        "device"
      ]
    },
    "annotations": {
      "readOnlyHint": true,
      "openWorldHint": true
    }
  },
  {
    "name": "mobile_set_orientation",
    "title": "Set Orientation",
    "description": "Change the screen orientation of the device",
    "inputSchema": {
      "type": "object",
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "properties": {
        "device": {
          "type": "string",
          "description": "The device identifier to use. Use mobile_list_available_devices to find which devices are available to you."
        },
        "orientation": {
          "type": "string",
          "enum": [
            "portrait",
            "landscape"
          ],
          "description": "The desired orientation"
        }
      },
      "required": [
        "device",
        "orientation"
      ]
    },
    "annotations": {
      "readOnlyHint": false,
      "destructiveHint": false,
      "openWorldHint": false
    }
  },
  {
    "name": "mobile_clipboard",
    "title": "Clipboard",
    "description": "Read or replace the device clipboard. Pass text to set the clipboard, omit it to read the current clipboard.",
    "inputSchema": {
      "type": "object",
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "properties": {
        "device": {
          "type": "string",
          "description": "The device identifier to use. Use mobile_list_available_devices to find which devices are available to you."
        },
        "text": {
          "description": "Text to place on the clipboard. Omit to read the clipboard instead.",
          "type": "string"
        }
      },
      "required": [
        "device"
      ]
    },
    "annotations": {
      "readOnlyHint": false,
      "destructiveHint": false,
      "openWorldHint": false
    }
  },
  {
    "name": "mobile_get_orientation",
    "title": "Get Orientation",
    "description": "Get the current screen orientation of the device",
    "inputSchema": {
      "type": "object",
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "properties": {
        "device": {
          "type": "string",
          "description": "The device identifier to use. Use mobile_list_available_devices to find which devices are available to you."
        }
      },
      "required": [
        "device"
      ]
    },
    "annotations": {
      "readOnlyHint": true,
      "openWorldHint": false
    }
  },
  {
    "name": "mobile_batch_commands",
    "title": "Batch Commands",
    "description": "Run multiple tools in sequence in a single call, e.g. click, type, click, type. Use this to fill forms or perform multi-step flows without round-trips. The device argument is applied to every step unless a step provides its own. Tools allowed as steps: mobile_list_available_devices, mobile_list_apps, mobile_get_foreground_app, mobile_launch_app, mobile_terminate_app, mobile_get_screen_size, mobile_click_on_screen_at_coordinates, mobile_double_tap_on_screen, mobile_long_press_on_screen_at_coordinates, mobile_list_elements_on_screen, mobile_press_button, mobile_open_url, mobile_swipe_on_screen, mobile_type_keys, mobile_set_orientation, mobile_get_orientation, mobile_clipboard.",
    "inputSchema": {
      "type": "object",
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "properties": {
        "device": {
          "type": "string",
          "description": "The device identifier to use. Use mobile_list_available_devices to find which devices are available to you."
        },
        "steps": {
          "minItems": 1,
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "name": {
                "type": "string",
                "description": "Name of a tool allowed as a step, e.g. mobile_click_on_screen_at_coordinates"
              },
              "arguments": {
                "type": "object",
                "propertyNames": {
                  "type": "string"
                },
                "additionalProperties": {},
                "description": "Arguments for the tool, same as calling it directly"
              }
            },
            "required": [
              "name",
              "arguments"
            ]
          },
          "description": "Tools to run, in order"
        },
        "stopOnError": {
          "description": "Stop at the first failing step. Defaults to true",
          "type": "boolean"
        },
        "listElementsAtEnd": {
          "description": "Run mobile_list_elements_on_screen after the last step and include its result. Defaults to false",
          "type": "boolean"
        }
      },
      "required": [
        "device",
        "steps"
      ]
    },
    "annotations": {
      "readOnlyHint": false,
      "destructiveHint": true,
      "openWorldHint": true
    }
  }
];
