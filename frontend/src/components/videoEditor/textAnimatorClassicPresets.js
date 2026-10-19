// GENERATED from html/finished/text-animators-lab/classic.js (via convert.js classicPresets) by
// tests/text-animators/port_from_lab.mjs. Do not edit here.
// Advanced Animations ▸ Presets ▸ Classic groups: the retired Text Animation presets
// rebuilt as animators (presets.js format; layerProps = the preset's non-animation look).
export const CLASSIC_CATEGORIES = [
 {
  "id": "classic-reveal",
  "name": "Classic · Reveal"
 },
 {
  "id": "classic-char",
  "name": "Classic · Character"
 },
 {
  "id": "classic-highlight",
  "name": "Classic · Highlight"
 },
 {
  "id": "classic-bar",
  "name": "Classic · Caption Bar"
 },
 {
  "id": "classic-random",
  "name": "Classic · Randomizer"
 }
];
export const CLASSIC_PRESETS = [
 {
  "id": "classic-fade-up",
  "name": "Fade Up",
  "cat": "classic-reveal",
  "description": "Words fade in, rising 50px",
  "sides": "inOut",
  "anchor": "drive",
  "animators": [
   {
    "name": "In",
    "range": {
     "basedOn": "words",
     "order": "forward",
     "stagger": 0.06,
     "mask": false,
     "spread": false,
     "drive": "time",
     "animate": "in",
     "duration": 0.6,
     "curve": "Power2 Smooth"
    },
    "effects": [
     [
      "position",
      {
       "x": 0,
       "y": 50
      }
     ],
     [
      "opacity",
      {
       "opacity": 0
      }
     ]
    ]
   },
   {
    "name": "Out",
    "range": {
     "basedOn": "words",
     "order": "forward",
     "stagger": 0.06,
     "mask": false,
     "spread": false,
     "drive": "time",
     "animate": "out",
     "duration": 0.5,
     "curve": "Power2 Smooth"
    },
    "effects": [
     [
      "position",
      {
       "x": 0,
       "y": -50
      }
     ],
     [
      "opacity",
      {
       "opacity": 0
      }
     ]
    ]
   }
  ],
  "classicOf": "fade-up"
 },
 {
  "id": "classic-fade-down",
  "name": "Fade Down",
  "cat": "classic-reveal",
  "description": "Words drop in from above",
  "sides": "inOut",
  "anchor": "drive",
  "animators": [
   {
    "name": "In",
    "range": {
     "basedOn": "words",
     "order": "forward",
     "stagger": 0.06,
     "mask": false,
     "spread": false,
     "drive": "time",
     "animate": "in",
     "duration": 0.6,
     "curve": "Power2 Smooth"
    },
    "effects": [
     [
      "position",
      {
       "x": 0,
       "y": -50
      }
     ],
     [
      "opacity",
      {
       "opacity": 0
      }
     ]
    ]
   },
   {
    "name": "Out",
    "range": {
     "basedOn": "words",
     "order": "forward",
     "stagger": 0.06,
     "mask": false,
     "spread": false,
     "drive": "time",
     "animate": "out",
     "duration": 0.5,
     "curve": "Power2 Smooth"
    },
    "effects": [
     [
      "position",
      {
       "x": 0,
       "y": 50
      }
     ],
     [
      "opacity",
      {
       "opacity": 0
      }
     ]
    ]
   }
  ],
  "classicOf": "fade-down"
 },
 {
  "id": "classic-rise-mask",
  "name": "Rise (Mask)",
  "cat": "classic-reveal",
  "description": "Words rise from behind a mask",
  "sides": "inOut",
  "anchor": "drive",
  "animators": [
   {
    "name": "In",
    "range": {
     "basedOn": "words",
     "order": "forward",
     "stagger": 0.08,
     "mask": true,
     "spread": false,
     "drive": "time",
     "animate": "in",
     "duration": 0.7,
     "curve": "Power2 Smooth"
    },
    "effects": [
     [
      "position",
      {
       "x": 0,
       "y": {
        "px": 90,
        "minEm": 1.15
       }
      }
     ]
    ]
   },
   {
    "name": "Out",
    "range": {
     "basedOn": "words",
     "order": "forward",
     "stagger": 0.08,
     "mask": true,
     "spread": false,
     "drive": "time",
     "animate": "out",
     "duration": 0.5,
     "curve": "Power2 Smooth"
    },
    "effects": [
     [
      "position",
      {
       "x": 0,
       "y": {
        "px": -90,
        "minEm": -1.15
       }
      }
     ]
    ]
   }
  ],
  "classicOf": "rise-mask"
 },
 {
  "id": "classic-blur-in",
  "name": "Blur In",
  "cat": "classic-reveal",
  "description": "Soft blur-focus reveal",
  "sides": "inOut",
  "anchor": "drive",
  "animators": [
   {
    "name": "In",
    "range": {
     "basedOn": "words",
     "order": "forward",
     "stagger": 0.07,
     "mask": false,
     "spread": false,
     "drive": "time",
     "animate": "in",
     "duration": 0.6,
     "curve": "Power2 Smooth"
    },
    "effects": [
     [
      "position",
      {
       "x": 0,
       "y": 12
      }
     ],
     [
      "blur",
      {
       "amount": 14
      }
     ],
     [
      "opacity",
      {
       "opacity": 0
      }
     ]
    ]
   },
   {
    "name": "Out",
    "range": {
     "basedOn": "words",
     "order": "forward",
     "stagger": 0.07,
     "mask": false,
     "spread": false,
     "drive": "time",
     "animate": "out",
     "duration": 0.45,
     "curve": "Power2 Smooth"
    },
    "effects": [
     [
      "blur",
      {
       "amount": 14
      }
     ],
     [
      "opacity",
      {
       "opacity": 0
      }
     ]
    ]
   }
  ],
  "classicOf": "blur-in"
 },
 {
  "id": "classic-slide-in",
  "name": "Slide In",
  "cat": "classic-reveal",
  "description": "Words slide in from the left",
  "sides": "inOut",
  "anchor": "drive",
  "animators": [
   {
    "name": "In",
    "range": {
     "basedOn": "words",
     "order": "forward",
     "stagger": 0.06,
     "mask": false,
     "spread": false,
     "drive": "time",
     "animate": "in",
     "duration": 0.6,
     "curve": "Power2 Smooth"
    },
    "effects": [
     [
      "position",
      {
       "x": -60,
       "y": 0
      }
     ],
     [
      "opacity",
      {
       "opacity": 0
      }
     ]
    ]
   },
   {
    "name": "Out",
    "range": {
     "basedOn": "words",
     "order": "forward",
     "stagger": 0.06,
     "mask": false,
     "spread": false,
     "drive": "time",
     "animate": "out",
     "duration": 0.5,
     "curve": "Power2 Smooth"
    },
    "effects": [
     [
      "position",
      {
       "x": 60,
       "y": 0
      }
     ],
     [
      "opacity",
      {
       "opacity": 0
      }
     ]
    ]
   }
  ],
  "classicOf": "slide-in"
 },
 {
  "id": "classic-side-mask",
  "name": "Side Mask",
  "cat": "classic-reveal",
  "description": "Each word slides sideways out of its own box and leaves through the other side",
  "sides": "inOut",
  "anchor": "drive",
  "animators": [
   {
    "name": "In",
    "range": {
     "basedOn": "words",
     "order": "forward",
     "stagger": 0.08,
     "mask": true,
     "spread": false,
     "drive": "time",
     "animate": "in",
     "duration": 0.7,
     "curve": "Expo Out"
    },
    "effects": [
     [
      "position",
      {
       "x": -300,
       "y": {
        "px": 0,
        "minEm": 1.15
       }
      }
     ]
    ]
   },
   {
    "name": "Out",
    "range": {
     "basedOn": "words",
     "order": "forward",
     "stagger": 0.08,
     "mask": true,
     "spread": false,
     "drive": "time",
     "animate": "out",
     "duration": 0.45,
     "curve": "Expo In"
    },
    "effects": [
     [
      "position",
      {
       "x": 300,
       "y": {
        "px": 0,
        "minEm": -1.15
       }
      }
     ]
    ]
   }
  ],
  "classicOf": "side-mask"
 },
 {
  "id": "classic-tilt-drop",
  "name": "Tilt Drop",
  "cat": "classic-reveal",
  "description": "Words fall in tilted and straighten with a bounce",
  "sides": "inOut",
  "anchor": "drive",
  "animators": [
   {
    "name": "In",
    "range": {
     "basedOn": "words",
     "order": "forward",
     "stagger": 0.09,
     "mask": false,
     "spread": false,
     "drive": "time",
     "animate": "in",
     "duration": 0.75,
     "curve": "Back Out"
    },
    "effects": [
     [
      "position",
      {
       "x": 0,
       "y": -90
      }
     ],
     [
      "rotation",
      {
       "angle": -14
      }
     ],
     [
      "opacity",
      {
       "opacity": 0
      }
     ]
    ]
   },
   {
    "name": "Out",
    "range": {
     "basedOn": "words",
     "order": "forward",
     "stagger": 0.09,
     "mask": false,
     "spread": false,
     "drive": "time",
     "animate": "out",
     "duration": 0.4,
     "curve": "Power2 In"
    },
    "effects": [
     [
      "position",
      {
       "x": 0,
       "y": 60
      }
     ],
     [
      "rotation",
      {
       "angle": 10
      }
     ],
     [
      "opacity",
      {
       "opacity": 0
      }
     ]
    ]
   }
  ],
  "classicOf": "tilt-drop"
 },
 {
  "id": "classic-flip-up",
  "name": "Flip Up",
  "cat": "classic-char",
  "description": "Characters flip up on the X axis",
  "sides": "inOut",
  "anchor": "drive",
  "animators": [
   {
    "name": "In",
    "range": {
     "basedOn": "chars",
     "order": "forward",
     "stagger": 0.03,
     "mask": false,
     "spread": false,
     "drive": "time",
     "animate": "in",
     "duration": 0.5,
     "curve": "Power2 Smooth"
    },
    "effects": [
     [
      "position",
      {
       "x": 0,
       "y": 10
      }
     ],
     [
      "rotate3d",
      {
       "x": 90,
       "y": 0
      }
     ],
     [
      "opacity",
      {
       "opacity": 0
      }
     ]
    ]
   },
   {
    "name": "Out",
    "range": {
     "basedOn": "chars",
     "order": "forward",
     "stagger": 0.03,
     "mask": false,
     "spread": false,
     "drive": "time",
     "animate": "out",
     "duration": 0.4,
     "curve": "Power2 Smooth"
    },
    "effects": [
     [
      "rotate3d",
      {
       "x": -90,
       "y": 0
      }
     ],
     [
      "opacity",
      {
       "opacity": 0
      }
     ]
    ]
   }
  ],
  "classicOf": "flip-up"
 },
 {
  "id": "classic-typewriter",
  "name": "Typewriter",
  "cat": "classic-char",
  "description": "Characters reveal one by one behind a blinking caret",
  "sides": "in",
  "anchor": "drive",
  "animators": [
   {
    "name": "In",
    "range": {
     "basedOn": "chars",
     "order": "forward",
     "stagger": 0.025,
     "mask": false,
     "spread": false,
     "drive": "time",
     "animate": "in",
     "duration": 0.12,
     "curve": "Power2 Smooth"
    },
    "effects": [
     [
      "opacity",
      {
       "opacity": 0
      }
     ],
     [
      "caret",
      {
       "style": "bar",
       "ownColor": false,
       "width": 0,
       "blink": 1.1,
       "hide": false,
       "hideAfter": 0
      }
     ]
    ]
   }
  ],
  "classicOf": "typewriter"
 },
 {
  "id": "classic-wave-rise",
  "name": "Wave Rise",
  "cat": "classic-char",
  "description": "Letters surge up in a rolling wave and settle with one soft overshoot",
  "sides": "inOut",
  "anchor": "drive",
  "animators": [
   {
    "name": "In",
    "range": {
     "basedOn": "chars",
     "order": "forward",
     "stagger": 0.03,
     "mask": false,
     "spread": false,
     "drive": "time",
     "animate": "in",
     "duration": 0.9,
     "curve": "Smooth Overshoot"
    },
    "effects": [
     [
      "position",
      {
       "x": 0,
       "y": 60
      }
     ],
     [
      "opacity",
      {
       "opacity": 0
      }
     ]
    ]
   },
   {
    "name": "Out",
    "range": {
     "basedOn": "chars",
     "order": "forward",
     "stagger": 0.03,
     "mask": false,
     "spread": false,
     "drive": "time",
     "animate": "out",
     "duration": 0.4,
     "curve": "Power2 In"
    },
    "effects": [
     [
      "position",
      {
       "x": 0,
       "y": -40
      }
     ],
     [
      "opacity",
      {
       "opacity": 0
      }
     ]
    ]
   }
  ],
  "classicOf": "wave-rise"
 },
 {
  "id": "classic-bounce-letters",
  "name": "Bounce Letters",
  "cat": "classic-char",
  "description": "Letters drop from above and bounce to rest",
  "sides": "inOut",
  "anchor": "drive",
  "animators": [
   {
    "name": "In",
    "range": {
     "basedOn": "chars",
     "order": "forward",
     "stagger": 0.04,
     "mask": false,
     "spread": false,
     "drive": "time",
     "animate": "in",
     "duration": 0.9,
     "curve": "Bounce Out"
    },
    "effects": [
     [
      "position",
      {
       "x": 0,
       "y": -140
      }
     ],
     [
      "opacity",
      {
       "opacity": 0
      }
     ]
    ]
   },
   {
    "name": "Out",
    "range": {
     "basedOn": "chars",
     "order": "forward",
     "stagger": 0.04,
     "mask": false,
     "spread": false,
     "drive": "time",
     "animate": "out",
     "duration": 0.3,
     "curve": "Power2 In"
    },
    "effects": [
     [
      "position",
      {
       "x": 0,
       "y": 40
      }
     ],
     [
      "opacity",
      {
       "opacity": 0
      }
     ]
    ]
   }
  ],
  "classicOf": "bounce-letters"
 },
 {
  "id": "classic-materialize",
  "name": "Materialize",
  "cat": "classic-char",
  "description": "Letters condense out of a cold glow, from blurred and large to sharp",
  "sides": "inOut",
  "anchor": "drive",
  "animators": [
   {
    "name": "In",
    "range": {
     "basedOn": "chars",
     "order": "forward",
     "stagger": 0.035,
     "mask": false,
     "spread": false,
     "drive": "time",
     "animate": "in",
     "duration": 0.7,
     "curve": "Power3 Out"
    },
    "effects": [
     [
      "scale",
      {
       "scale": 135
      }
     ],
     [
      "blur",
      {
       "amount": 18
      }
     ],
     [
      "opacity",
      {
       "opacity": 0
      }
     ]
    ]
   },
   {
    "name": "Out",
    "range": {
     "basedOn": "chars",
     "order": "forward",
     "stagger": 0.035,
     "mask": false,
     "spread": false,
     "drive": "time",
     "animate": "out",
     "duration": 0.4,
     "curve": "Power2 In"
    },
    "effects": [
     [
      "blur",
      {
       "amount": 12
      }
     ],
     [
      "opacity",
      {
       "opacity": 0
      }
     ]
    ]
   },
   {
    "name": "Highlight",
    "range": {
     "drive": "time",
     "animate": "active",
     "order": "forward",
     "curve": "Linear",
     "delay": 0,
     "fadeOut": 0.6,
     "keepLast": false,
     "basedOn": "chars",
     "stagger": 0.035,
     "duration": 0,
     "hold": 0
    },
    "effects": [
     [
      "glow",
      {
       "color": "#7ad7ff",
       "size": 26,
       "strength": 100
      }
     ]
    ]
   }
  ],
  "classicOf": "materialize"
 },
 {
  "id": "classic-neon-runner",
  "name": "Neon Runner",
  "cat": "classic-highlight",
  "description": "A glow sweeps across each word",
  "sides": "in",
  "anchor": "drive",
  "animators": [
   {
    "name": "In",
    "range": {
     "basedOn": "words",
     "order": "forward",
     "stagger": 0.16,
     "mask": false,
     "spread": false,
     "drive": "time",
     "animate": "in",
     "duration": 0.35,
     "curve": "Power2 Smooth"
    },
    "effects": [
     [
      "opacity",
      {
       "opacity": 0
      }
     ]
    ]
   },
   {
    "name": "Highlight",
    "range": {
     "drive": "time",
     "animate": "active",
     "order": "forward",
     "curve": "Linear",
     "delay": 0,
     "fadeOut": 0,
     "keepLast": false,
     "basedOn": "words",
     "stagger": 0.16,
     "duration": 0,
     "hold": 0
    },
    "effects": [
     [
      "fill",
      {
       "color": "#7c5cff"
      }
     ],
     [
      "glow",
      {
       "color": "#7c5cff",
       "size": 28,
       "strength": 100
      }
     ]
    ]
   }
  ],
  "classicOf": "neon-runner"
 },
 {
  "id": "classic-ink-highlight",
  "name": "Ink Highlight",
  "cat": "classic-highlight",
  "description": "Each word flashes a colour as it lands",
  "sides": "in",
  "anchor": "drive",
  "animators": [
   {
    "name": "In",
    "range": {
     "basedOn": "words",
     "order": "forward",
     "stagger": 0.16,
     "mask": false,
     "spread": false,
     "drive": "time",
     "animate": "in",
     "duration": 0.35,
     "curve": "Power2 Smooth"
    },
    "effects": [
     [
      "position",
      {
       "x": 0,
       "y": 14
      }
     ],
     [
      "opacity",
      {
       "opacity": 0
      }
     ]
    ]
   },
   {
    "name": "Highlight",
    "range": {
     "drive": "time",
     "animate": "active",
     "order": "forward",
     "curve": "Linear",
     "delay": 0,
     "fadeOut": 0,
     "keepLast": false,
     "basedOn": "words",
     "stagger": 0.16,
     "duration": 0,
     "hold": 0
    },
    "effects": [
     [
      "fill",
      {
       "color": "#ff5c8a"
      }
     ]
    ]
   }
  ],
  "classicOf": "ink-highlight"
 },
 {
  "id": "classic-flash-type",
  "name": "Flash Type",
  "cat": "classic-highlight",
  "description": "Characters reveal with a running colour flash that trails off",
  "sides": "in",
  "anchor": "drive",
  "animators": [
   {
    "name": "In",
    "range": {
     "basedOn": "chars",
     "order": "forward",
     "stagger": 0.05,
     "mask": false,
     "spread": false,
     "drive": "time",
     "animate": "in",
     "duration": 0.15,
     "curve": "Power2 Smooth"
    },
    "effects": [
     [
      "opacity",
      {
       "opacity": 0
      }
     ]
    ]
   },
   {
    "name": "Highlight",
    "range": {
     "drive": "time",
     "animate": "active",
     "order": "forward",
     "curve": "Linear",
     "delay": 0.05,
     "fadeOut": 0.15,
     "keepLast": false,
     "basedOn": "chars",
     "stagger": 0.05,
     "duration": 0,
     "hold": 0
    },
    "effects": [
     [
      "fill",
      {
       "color": "#ff044b"
      }
     ]
    ]
   }
  ],
  "classicOf": "flash-type"
 },
 {
  "id": "classic-karaoke-sweep",
  "name": "Karaoke Sweep",
  "cat": "classic-highlight",
  "description": "Fast type-in, then a bar walks word by word on its own clock",
  "sides": "in",
  "anchor": "drive",
  "animators": [
   {
    "name": "In",
    "range": {
     "basedOn": "chars",
     "order": "forward",
     "stagger": 0.02,
     "mask": false,
     "spread": false,
     "drive": "time",
     "animate": "in",
     "duration": 0.25,
     "curve": "Power2 Smooth"
    },
    "effects": [
     [
      "opacity",
      {
       "opacity": 0
      }
     ]
    ]
   },
   {
    "name": "Highlight",
    "range": {
     "drive": "time",
     "animate": "active",
     "order": "forward",
     "curve": "Linear",
     "delay": 0.4,
     "fadeOut": 0.2,
     "keepLast": true,
     "basedOn": "words",
     "stagger": 0.45,
     "duration": 0,
     "hold": 0,
     "loop": false
    },
    "effects": [
     [
      "box",
      {
       "color": "#ffe74c",
       "padX": 10,
       "padY": 10,
       "radius": {
        "px": 10,
        "em": 0.14
       },
       "grow": false,
       "behind": "selected",
       "shape": "unit",
       "opacity": 100,
       "withText": true
      }
     ]
    ]
   }
  ],
  "classicOf": "karaoke-sweep"
 },
 {
  "id": "classic-chase-loop",
  "name": "Chase Loop",
  "cat": "classic-highlight",
  "description": "An accent keeps chasing through the words for as long as the clip runs",
  "sides": "inOut",
  "anchor": "drive",
  "animators": [
   {
    "name": "In",
    "range": {
     "basedOn": "words",
     "order": "forward",
     "stagger": 0.03,
     "mask": false,
     "spread": false,
     "drive": "time",
     "animate": "in",
     "duration": 0.3,
     "curve": "Power2 Smooth"
    },
    "effects": [
     [
      "opacity",
      {
       "opacity": 0
      }
     ]
    ]
   },
   {
    "name": "Out",
    "range": {
     "basedOn": "words",
     "order": "forward",
     "stagger": 0.03,
     "mask": false,
     "spread": false,
     "drive": "time",
     "animate": "out",
     "duration": 0.3,
     "curve": "Power2 Smooth"
    },
    "effects": [
     [
      "opacity",
      {
       "opacity": 0
      }
     ]
    ]
   },
   {
    "name": "Highlight",
    "range": {
     "drive": "time",
     "animate": "active",
     "order": "forward",
     "curve": "Linear",
     "delay": 0.4,
     "fadeOut": 0.35,
     "keepLast": false,
     "basedOn": "words",
     "stagger": 0.3,
     "duration": 0.12,
     "hold": 0,
     "loop": true
    },
    "effects": [
     [
      "fill",
      {
       "color": "#33efab"
      }
     ]
    ]
   }
  ],
  "classicOf": "chase-loop"
 },
 {
  "id": "classic-sung-words",
  "name": "Sung Words",
  "cat": "classic-highlight",
  "description": "Karaoke fill: each word turns gold on its beat and stays gold",
  "sides": "inOut",
  "anchor": "drive",
  "animators": [
   {
    "name": "In",
    "range": {
     "basedOn": "words",
     "order": "forward",
     "stagger": 0.04,
     "mask": false,
     "spread": false,
     "drive": "time",
     "animate": "in",
     "duration": 0.35,
     "curve": "Power2 Smooth"
    },
    "effects": [
     [
      "position",
      {
       "x": 0,
       "y": 10
      }
     ],
     [
      "opacity",
      {
       "opacity": 0
      }
     ]
    ]
   },
   {
    "name": "Out",
    "range": {
     "basedOn": "words",
     "order": "forward",
     "stagger": 0.04,
     "mask": false,
     "spread": false,
     "drive": "time",
     "animate": "out",
     "duration": 0.3,
     "curve": "Power2 Smooth"
    },
    "effects": [
     [
      "opacity",
      {
       "opacity": 0
      }
     ]
    ]
   },
   {
    "name": "Highlight",
    "range": {
     "drive": "time",
     "animate": "active",
     "order": "forward",
     "curve": "Linear",
     "delay": 0.5,
     "fadeOut": 0,
     "keepLast": false,
     "basedOn": "words",
     "stagger": 0.32,
     "duration": 0.15,
     "hold": 10,
     "loop": false
    },
    "effects": [
     [
      "fill",
      {
       "color": "#ffd23f"
      }
     ]
    ]
   }
  ],
  "classicOf": "sung-words"
 },
 {
  "id": "classic-marker-lines",
  "name": "Marker Words",
  "cat": "classic-highlight",
  "description": "Words rise from a mask, then a marker stroke lands under each word and stays",
  "sides": "in",
  "anchor": "drive",
  "animators": [
   {
    "name": "In",
    "range": {
     "basedOn": "words",
     "order": "forward",
     "stagger": 0.06,
     "mask": true,
     "spread": false,
     "drive": "time",
     "animate": "in",
     "duration": 0.7,
     "curve": "Expo Out"
    },
    "effects": [
     [
      "position",
      {
       "x": 0,
       "y": {
        "px": 90,
        "minEm": 1.15
       }
      }
     ]
    ]
   },
   {
    "name": "Highlight",
    "range": {
     "drive": "time",
     "animate": "active",
     "order": "forward",
     "curve": "Linear",
     "delay": 0.9,
     "fadeOut": 0,
     "keepLast": false,
     "basedOn": "words",
     "stagger": 0.12,
     "duration": 0.25,
     "hold": 10,
     "loop": false
    },
    "effects": [
     [
      "box",
      {
       "color": "#ff3d6e",
       "padX": 6,
       "padY": 6,
       "radius": {
        "px": 6,
        "em": 0.14
       },
       "grow": false,
       "behind": "selected",
       "shape": "unit",
       "opacity": 100,
       "withText": true
      }
     ]
    ]
   }
  ],
  "classicOf": "marker-lines"
 },
 {
  "id": "classic-pill-grow",
  "name": "Pill Grow",
  "cat": "classic-bar",
  "description": "Words rise, then a dot pops at their left and stretches into a pill behind them",
  "sides": "inOut",
  "anchor": "drive",
  "animators": [
   {
    "name": "In",
    "range": {
     "basedOn": "words",
     "order": "forward",
     "stagger": 0.07,
     "mask": false,
     "spread": false,
     "drive": "time",
     "animate": "in",
     "duration": 0.5,
     "curve": "Power3 Out"
    },
    "effects": [
     [
      "position",
      {
       "x": 0,
       "y": 24
      }
     ],
     [
      "opacity",
      {
       "opacity": 0
      }
     ]
    ]
   },
   {
    "name": "Out",
    "range": {
     "basedOn": "words",
     "order": "forward",
     "stagger": 0.07,
     "mask": false,
     "spread": false,
     "drive": "time",
     "animate": "out",
     "duration": 0.25,
     "curve": "Power2 In"
    },
    "effects": [
     [
      "position",
      {
       "x": 0,
       "y": -16
      }
     ],
     [
      "opacity",
      {
       "opacity": 0
      }
     ]
    ]
   }
  ],
  "classicOf": "pill-grow",
  "layerProps": {
   "textBgEnabled": true,
   "textBgColor": "#2f6bff",
   "textBgPaddingX": 40,
   "textBgPaddingY": 20,
   "textBgRadius": 200,
   "textBorderEnabled": false,
   "textBgInType": "mask-right",
   "textBgInStyle": "grow",
   "textBgInDuration": 0.55,
   "textBgInEasing": "Expo Out",
   "textBgInDelay": 0.15,
   "textBgInGrowStart": 0,
   "textBgInGrowAppear": "scale-in",
   "textBgInGrowAppearDuration": 0.25,
   "textBgInGrowAppearEasing": "Back Out",
   "textBgOutType": "mask-right",
   "textBgOutStyle": "grow",
   "textBgOutDuration": 0.3,
   "textBgOutEasing": "Power2 In",
   "textBgOutGrowStart": 0,
   "textBgOutGrowAppear": "scale-in",
   "textBgOutGrowAppearDuration": 0.15,
   "textBgOutGrowAppearEasing": "Ease In"
  }
 },
 {
  "id": "classic-lower-third",
  "name": "Lower Third",
  "cat": "classic-bar",
  "description": "The bar slides in behind a mask while each word slides out of its own box; exits the same way",
  "sides": "inOut",
  "anchor": "drive",
  "animators": [
   {
    "name": "In",
    "range": {
     "basedOn": "words",
     "order": "forward",
     "stagger": 0.06,
     "mask": true,
     "spread": false,
     "drive": "time",
     "animate": "in",
     "duration": 0.7,
     "curve": "Expo Out"
    },
    "effects": [
     [
      "position",
      {
       "x": -260,
       "y": {
        "px": 0,
        "minEm": 1.15
       }
      }
     ]
    ]
   },
   {
    "name": "Out",
    "range": {
     "basedOn": "words",
     "order": "forward",
     "stagger": 0.06,
     "mask": true,
     "spread": false,
     "drive": "time",
     "animate": "out",
     "duration": 0.45,
     "curve": "Expo In"
    },
    "effects": [
     [
      "position",
      {
       "x": 260,
       "y": {
        "px": 0,
        "minEm": -1.15
       }
      }
     ]
    ]
   }
  ],
  "classicOf": "lower-third",
  "layerProps": {
   "textBgEnabled": true,
   "textBgColor": "rgba(10,10,14,0.88)",
   "textBgPaddingX": 34,
   "textBgPaddingY": 18,
   "textBgRadius": 6,
   "textBorderEnabled": false,
   "textBgInType": "mask-right",
   "textBgInStyle": "slide",
   "textBgInDuration": 0.55,
   "textBgInEasing": "Expo Out",
   "textBgInDelay": 0,
   "textBgOutType": "mask-right",
   "textBgOutStyle": "slide",
   "textBgOutDuration": 0.45,
   "textBgOutEasing": "Expo In"
  }
 },
 {
  "id": "classic-drop-bar",
  "name": "Drop Bar",
  "cat": "classic-bar",
  "description": "Bar and words drop in from above behind masks, and fall away below",
  "sides": "inOut",
  "anchor": "drive",
  "animators": [
   {
    "name": "In",
    "range": {
     "basedOn": "words",
     "order": "forward",
     "stagger": 0.05,
     "mask": true,
     "spread": false,
     "drive": "time",
     "animate": "in",
     "duration": 0.6,
     "curve": "Expo Out"
    },
    "effects": [
     [
      "position",
      {
       "x": 0,
       "y": {
        "px": -90,
        "minEm": 1.15
       }
      }
     ]
    ]
   },
   {
    "name": "Out",
    "range": {
     "basedOn": "words",
     "order": "forward",
     "stagger": 0.05,
     "mask": true,
     "spread": false,
     "drive": "time",
     "animate": "out",
     "duration": 0.4,
     "curve": "Expo In"
    },
    "effects": [
     [
      "position",
      {
       "x": 0,
       "y": {
        "px": 90,
        "minEm": -1.15
       }
      }
     ]
    ]
   }
  ],
  "classicOf": "drop-bar",
  "layerProps": {
   "textBgEnabled": true,
   "textBgColor": "#7c5cff",
   "textBgPaddingX": 34,
   "textBgPaddingY": 16,
   "textBgRadius": 10,
   "textBorderEnabled": false,
   "textBgInType": "mask-down",
   "textBgInStyle": "slide",
   "textBgInDuration": 0.5,
   "textBgInEasing": "Expo Out",
   "textBgInDelay": 0,
   "textBgOutType": "mask-down",
   "textBgOutStyle": "slide",
   "textBgOutDuration": 0.4,
   "textBgOutEasing": "Expo In"
  }
 },
 {
  "id": "classic-outline-tag",
  "name": "Outline Tag",
  "cat": "classic-bar",
  "description": "An outline draws itself open to the right while the letters slide in",
  "sides": "inOut",
  "anchor": "drive",
  "animators": [
   {
    "name": "In",
    "range": {
     "basedOn": "chars",
     "order": "forward",
     "stagger": 0.022,
     "mask": false,
     "spread": false,
     "drive": "time",
     "animate": "in",
     "duration": 0.3,
     "curve": "Power2 Out"
    },
    "effects": [
     [
      "position",
      {
       "x": -12,
       "y": 0
      }
     ],
     [
      "opacity",
      {
       "opacity": 0
      }
     ]
    ]
   },
   {
    "name": "Out",
    "range": {
     "basedOn": "chars",
     "order": "forward",
     "stagger": 0.022,
     "mask": false,
     "spread": false,
     "drive": "time",
     "animate": "out",
     "duration": 0.2,
     "curve": "Power2 In"
    },
    "effects": [
     [
      "opacity",
      {
       "opacity": 0
      }
     ]
    ]
   }
  ],
  "classicOf": "outline-tag",
  "layerProps": {
   "textBgEnabled": false,
   "textBgColor": "rgba(0,0,0,0.6)",
   "textBgPaddingX": 36,
   "textBgPaddingY": 18,
   "textBgRadius": 14,
   "textBorderEnabled": true,
   "textBorderColor": "#33efab",
   "textBorderWidth": 3,
   "textBorderStyle": "solid",
   "textBgInType": "mask-right",
   "textBgInStyle": "grow",
   "textBgInDuration": 0.6,
   "textBgInEasing": "Power3 Out",
   "textBgInDelay": 0,
   "textBgInGrowStart": 0,
   "textBgInGrowAppear": "fade",
   "textBgInGrowAppearDuration": 0.2,
   "textBgInGrowAppearEasing": "Ease Out",
   "textBgOutType": "mask-right",
   "textBgOutStyle": "grow",
   "textBgOutDuration": 0.4,
   "textBgOutEasing": "Power2 In",
   "textBgOutGrowStart": 0,
   "textBgOutGrowAppear": "none",
   "textBgOutGrowAppearDuration": 0.4,
   "textBgOutGrowAppearEasing": "Ease In"
  }
 },
 {
  "id": "classic-prompt-field",
  "name": "Prompt Field",
  "cat": "classic-bar",
  "description": "An outlined pill fades in and the text types inside it behind a caret, like a search box",
  "sides": "inOut",
  "anchor": "drive",
  "animators": [
   {
    "name": "In",
    "range": {
     "basedOn": "chars",
     "order": "forward",
     "stagger": 0.04,
     "mask": false,
     "spread": false,
     "drive": "time",
     "animate": "in",
     "duration": 0.05,
     "curve": "Linear"
    },
    "effects": [
     [
      "opacity",
      {
       "opacity": 0
      }
     ],
     [
      "caret",
      {
       "style": "bar",
       "ownColor": false,
       "width": 0,
       "blink": 1.1,
       "hide": false,
       "hideAfter": 0
      }
     ]
    ]
   },
   {
    "name": "Out",
    "range": {
     "basedOn": "chars",
     "order": "forward",
     "stagger": 0.04,
     "mask": false,
     "spread": false,
     "drive": "time",
     "animate": "out",
     "duration": 0.2,
     "curve": "Power2 In"
    },
    "effects": [
     [
      "opacity",
      {
       "opacity": 0
      }
     ]
    ]
   }
  ],
  "classicOf": "prompt-field",
  "layerProps": {
   "textBgEnabled": false,
   "textBgColor": "rgba(0,0,0,0.6)",
   "textBgPaddingX": 46,
   "textBgPaddingY": 28,
   "textBgRadius": 200,
   "textBorderEnabled": true,
   "textBorderColor": "rgba(255,255,255,0.5)",
   "textBorderWidth": 3,
   "textBorderStyle": "solid",
   "textBgInType": "fade",
   "textBgInStyle": "wipe",
   "textBgInDuration": 0.35,
   "textBgInEasing": "Ease Out",
   "textBgInDelay": 0,
   "textBgOutType": "fade",
   "textBgOutStyle": "wipe",
   "textBgOutDuration": 0.3,
   "textBgOutEasing": "Ease In"
  }
 },
 {
  "id": "classic-random-pop",
  "name": "Random Pop",
  "cat": "classic-random",
  "description": "Words pop in, each with a random size and accent colour",
  "sides": "inOut",
  "anchor": "drive",
  "animators": [
   {
    "name": "In",
    "range": {
     "basedOn": "words",
     "order": "forward",
     "stagger": 0.05,
     "mask": false,
     "spread": false,
     "drive": "time",
     "animate": "in",
     "duration": 0.45,
     "curve": "Back Out"
    },
    "effects": [
     [
      "scale",
      {
       "scale": 40
      }
     ],
     [
      "opacity",
      {
       "opacity": 0
      }
     ]
    ]
   },
   {
    "name": "Out",
    "range": {
     "basedOn": "words",
     "order": "forward",
     "stagger": 0.05,
     "mask": false,
     "spread": false,
     "drive": "time",
     "animate": "out",
     "duration": 0.4,
     "curve": "Power2 Smooth"
    },
    "effects": [
     [
      "scale",
      {
       "scale": 50
      }
     ],
     [
      "opacity",
      {
       "opacity": 0
      }
     ]
    ]
   }
  ],
  "classicOf": "random-pop",
  "layerProps": {
   "textRandomEnabled": true,
   "textRandomScope": "words",
   "textRandomDist": "uniform",
   "textRandomNth": 3,
   "textRandomSeed": 7,
   "textRandomSizeEnabled": true,
   "textRandomSizeMin": 85,
   "textRandomSizeMax": 150,
   "textRandomColorEnabled": true,
   "textRandomColors": [
    "#33efab"
   ],
   "textRandomCoverage": 40,
   "textRandomWeightEnabled": true,
   "textRandomWeights": [
    400,
    800
   ],
   "textRandomItalicEnabled": false,
   "textRandomItalicMode": "mix",
   "textRandomItalicShare": 30
  }
 },
 {
  "id": "classic-chaos-letters",
  "name": "Chaos Letters",
  "cat": "classic-random",
  "description": "Characters flip in with scattered sizes and weights",
  "sides": "inOut",
  "anchor": "drive",
  "animators": [
   {
    "name": "In",
    "range": {
     "basedOn": "chars",
     "order": "forward",
     "stagger": 0.03,
     "mask": false,
     "spread": false,
     "drive": "time",
     "animate": "in",
     "duration": 0.5,
     "curve": "Power2 Smooth"
    },
    "effects": [
     [
      "position",
      {
       "x": 0,
       "y": 10
      }
     ],
     [
      "rotate3d",
      {
       "x": 90,
       "y": 0
      }
     ],
     [
      "opacity",
      {
       "opacity": 0
      }
     ]
    ]
   },
   {
    "name": "Out",
    "range": {
     "basedOn": "chars",
     "order": "forward",
     "stagger": 0.03,
     "mask": false,
     "spread": false,
     "drive": "time",
     "animate": "out",
     "duration": 0.4,
     "curve": "Power2 Smooth"
    },
    "effects": [
     [
      "rotate3d",
      {
       "x": -90,
       "y": 0
      }
     ],
     [
      "opacity",
      {
       "opacity": 0
      }
     ]
    ]
   }
  ],
  "classicOf": "chaos-letters",
  "layerProps": {
   "textRandomEnabled": true,
   "textRandomScope": "symbols",
   "textRandomDist": "gaussian",
   "textRandomNth": 3,
   "textRandomSeed": 21,
   "textRandomSizeEnabled": true,
   "textRandomSizeMin": 70,
   "textRandomSizeMax": 160,
   "textRandomColorEnabled": false,
   "textRandomColors": [],
   "textRandomCoverage": 35,
   "textRandomWeightEnabled": true,
   "textRandomWeights": [
    300,
    700
   ],
   "textRandomItalicEnabled": true,
   "textRandomItalicMode": "mix",
   "textRandomItalicShare": 25
  }
 },
 {
  "id": "classic-random-rise",
  "name": "Random Rise",
  "cat": "classic-random",
  "description": "Masked rise; a wave of size and two colours rolls across the words",
  "sides": "inOut",
  "anchor": "drive",
  "animators": [
   {
    "name": "In",
    "range": {
     "basedOn": "words",
     "order": "forward",
     "stagger": 0.08,
     "mask": true,
     "spread": false,
     "drive": "time",
     "animate": "in",
     "duration": 0.7,
     "curve": "Power2 Smooth"
    },
    "effects": [
     [
      "position",
      {
       "x": 0,
       "y": {
        "px": 90,
        "minEm": 1.15
       }
      }
     ]
    ]
   },
   {
    "name": "Out",
    "range": {
     "basedOn": "words",
     "order": "forward",
     "stagger": 0.08,
     "mask": true,
     "spread": false,
     "drive": "time",
     "animate": "out",
     "duration": 0.5,
     "curve": "Power2 Smooth"
    },
    "effects": [
     [
      "position",
      {
       "x": 0,
       "y": {
        "px": -90,
        "minEm": -1.15
       }
      }
     ]
    ]
   }
  ],
  "classicOf": "random-rise",
  "layerProps": {
   "textRandomEnabled": true,
   "textRandomScope": "words",
   "textRandomDist": "wave",
   "textRandomNth": 3,
   "textRandomSeed": 12,
   "textRandomSizeEnabled": true,
   "textRandomSizeMin": 90,
   "textRandomSizeMax": 140,
   "textRandomColorEnabled": true,
   "textRandomColors": [
    "#7aa2ff",
    "#ff6b81"
   ],
   "textRandomCoverage": 45,
   "textRandomWeightEnabled": true,
   "textRandomWeights": [
    500,
    900
   ],
   "textRandomItalicEnabled": false,
   "textRandomItalicMode": "mix",
   "textRandomItalicShare": 30
  }
 },
 {
  "id": "classic-ransom-note",
  "name": "Ransom Note",
  "cat": "classic-random",
  "description": "Cut-out letters: wild sizes, three colours, mixed weights and italics",
  "sides": "in",
  "anchor": "drive",
  "animators": [
   {
    "name": "In",
    "range": {
     "basedOn": "chars",
     "order": "forward",
     "stagger": 0.025,
     "mask": false,
     "spread": false,
     "drive": "time",
     "animate": "in",
     "duration": 0.4,
     "curve": "Power2 Smooth"
    },
    "effects": [
     [
      "scale",
      {
       "scale": 30
      }
     ],
     [
      "rotation",
      {
       "angle": 8
      }
     ],
     [
      "opacity",
      {
       "opacity": 0
      }
     ]
    ]
   }
  ],
  "classicOf": "ransom-note",
  "layerProps": {
   "textRandomEnabled": true,
   "textRandomScope": "symbols",
   "textRandomDist": "uniform",
   "textRandomNth": 3,
   "textRandomSeed": 33,
   "textRandomSizeEnabled": true,
   "textRandomSizeMin": 75,
   "textRandomSizeMax": 165,
   "textRandomColorEnabled": true,
   "textRandomColors": [
    "#ffd166",
    "#ff6b81",
    "#7aa2ff"
   ],
   "textRandomCoverage": 60,
   "textRandomWeightEnabled": true,
   "textRandomWeights": [
    400,
    700,
    900
   ],
   "textRandomItalicEnabled": true,
   "textRandomItalicMode": "mix",
   "textRandomItalicShare": 30
  }
 },
 {
  "id": "classic-editorial-typer",
  "name": "Editorial Typer",
  "cat": "classic-random",
  "description": "Word typing behind a caret, set in a wave of weights, sizes and italics",
  "sides": "inOut",
  "anchor": "drive",
  "animators": [
   {
    "name": "In",
    "range": {
     "basedOn": "words",
     "order": "forward",
     "stagger": 0.18,
     "mask": false,
     "spread": false,
     "drive": "time",
     "animate": "in",
     "duration": 0.14,
     "curve": "Power2 Out"
    },
    "effects": [
     [
      "position",
      {
       "x": 0,
       "y": 12
      }
     ],
     [
      "opacity",
      {
       "opacity": 0
      }
     ],
     [
      "caret",
      {
       "style": "bar",
       "ownColor": false,
       "width": 0,
       "blink": 1.1,
       "hide": true,
       "hideAfter": 1
      }
     ]
    ]
   },
   {
    "name": "Out",
    "range": {
     "basedOn": "words",
     "order": "forward",
     "stagger": 0.18,
     "mask": false,
     "spread": false,
     "drive": "time",
     "animate": "out",
     "duration": 0.25,
     "curve": "Power2 In"
    },
    "effects": [
     [
      "opacity",
      {
       "opacity": 0
      }
     ]
    ]
   }
  ],
  "classicOf": "editorial-typer",
  "layerProps": {
   "textRandomEnabled": true,
   "textRandomScope": "words",
   "textRandomDist": "wave",
   "textRandomNth": 3,
   "textRandomSeed": 5,
   "textRandomSizeEnabled": true,
   "textRandomSizeMin": 88,
   "textRandomSizeMax": 128,
   "textRandomColorEnabled": false,
   "textRandomColors": [],
   "textRandomCoverage": 35,
   "textRandomWeightEnabled": true,
   "textRandomWeights": [
    300,
    800
   ],
   "textRandomItalicEnabled": true,
   "textRandomItalicMode": "mix",
   "textRandomItalicShare": 35
  }
 }
];
