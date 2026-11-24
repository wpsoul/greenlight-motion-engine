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
     "curve": "Smooth"
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
     "curve": "Smooth"
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
     "curve": "Smooth"
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
     "curve": "Smooth"
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
     "curve": "Smooth"
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
     "curve": "Smooth"
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
     "curve": "Smooth"
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
     "curve": "Smooth"
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
     "curve": "Smooth"
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
     "curve": "Smooth"
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
     "curve": "Ease In"
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
     "curve": "Smooth"
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
     "curve": "Smooth"
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
     "curve": "Smooth"
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
     "curve": "Ease In"
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
     "curve": "Ease In"
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
     "curve": "Cubic Out"
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
     "curve": "Ease In"
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
     "curve": "Smooth"
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
     "curve": "Smooth"
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
     "curve": "Smooth"
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
     "curve": "Smooth"
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
     "curve": "Smooth"
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
     "curve": "Smooth"
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
     "curve": "Smooth"
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
     "curve": "Smooth"
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
  "description": "Words rise one by one onto a pill that grows with them; it shrinks away as they leave",
  "sides": "inOut",
  "anchor": "drive",
  "animators": [
   {
    "name": "Plate",
    "range": {
     "basedOn": "words",
     "order": "forward",
     "stagger": 0.07,
     "mask": false,
     "spread": false,
     "drive": "time",
     "animate": "inOut",
     "duration": 0.2,
     "curve": "Ease Out"
    },
    "effects": [
     [
      "box",
      {
       "color": "#2f6bff",
       "behind": "revealed",
       "shape": "block",
       "padX": 40,
       "padY": 20,
       "radius": 200
      }
     ]
    ]
   },
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
     "curve": "Cubic Out"
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
     "curve": "Ease In"
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
   "textBgEnabled": false,
   "textBorderEnabled": false
  }
 },
 {
  "id": "classic-lower-third",
  "name": "Lower Third",
  "cat": "classic-bar",
  "description": "Each word slides out of its own box while the dark bar grows to take it; the bar shrinks back as the words leave",
  "sides": "inOut",
  "anchor": "drive",
  "animators": [
   {
    "name": "Plate",
    "range": {
     "basedOn": "words",
     "order": "forward",
     "stagger": 0.06,
     "mask": false,
     "spread": false,
     "drive": "time",
     "animate": "inOut",
     "duration": 0.2,
     "curve": "Ease Out"
    },
    "effects": [
     [
      "box",
      {
       "color": "#0a0a0ee0",
       "behind": "revealed",
       "shape": "block",
       "padX": 34,
       "padY": 18,
       "radius": 6
      }
     ]
    ]
   },
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
   "textBgEnabled": false,
   "textBorderEnabled": false
  }
 },
 {
  "id": "classic-drop-bar",
  "name": "Drop Bar",
  "cat": "classic-bar",
  "description": "Words drop in from above behind masks onto a bar that grows with them, then fall away below as it shrinks",
  "sides": "inOut",
  "anchor": "drive",
  "animators": [
   {
    "name": "Plate",
    "range": {
     "basedOn": "words",
     "order": "forward",
     "stagger": 0.05,
     "mask": false,
     "spread": false,
     "drive": "time",
     "animate": "inOut",
     "duration": 0.2,
     "curve": "Ease Out"
    },
    "effects": [
     [
      "box",
      {
       "color": "#7c5cff",
       "behind": "revealed",
       "shape": "block",
       "padX": 34,
       "padY": 16,
       "radius": 10
      }
     ]
    ]
   },
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
   "textBgEnabled": false,
   "textBorderEnabled": false
  }
 },
 {
  "id": "classic-outline-tag",
  "name": "Outline Tag",
  "cat": "classic-bar",
  "description": "Letters slide in while an outline grows around them; it shrinks back as they fade out",
  "sides": "inOut",
  "anchor": "drive",
  "animators": [
   {
    "name": "Plate",
    "range": {
     "basedOn": "chars",
     "order": "forward",
     "stagger": 0.022,
     "mask": false,
     "spread": false,
     "drive": "time",
     "animate": "inOut",
     "duration": 0.2,
     "curve": "Ease Out"
    },
    "effects": [
     [
      "box",
      {
       "color": "#00000000",
       "behind": "revealed",
       "shape": "block",
       "padX": 36,
       "padY": 18,
       "radius": 14,
       "border": 3,
       "borderColor": "#33efab"
      }
     ]
    ]
   },
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
     "curve": "Ease Out"
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
     "curve": "Ease In"
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
   "textBorderEnabled": false
  }
 },
 {
  "id": "classic-prompt-field",
  "name": "Prompt Field",
  "cat": "classic-bar",
  "description": "An outlined field fades in, the text types into it behind a caret, and the field fades out with it",
  "sides": "inOut",
  "anchor": "drive",
  "animators": [
   {
    "name": "Plate",
    "range": {
     "basedOn": "chars",
     "order": "forward",
     "stagger": 0,
     "mask": false,
     "spread": false,
     "drive": "time",
     "animate": "inOut",
     "duration": 0.35,
     "curve": "Ease Out"
    },
    "effects": [
     [
      "box",
      {
       "color": "#00000000",
       "behind": "revealed",
       "shape": "block",
       "padX": 46,
       "padY": 28,
       "radius": 200,
       "border": 3,
       "borderColor": "#ffffff80"
      }
     ]
    ]
   },
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
     "curve": "Ease In"
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
   "textBorderEnabled": false
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
    "name": "Size",
    "range": {
     "basedOn": "words"
    },
    "wiggle": {
     "rate": 0,
     "corr": 0,
     "seed": 4650,
     "max": 100,
     "min": -30
    },
    "effects": [
     [
      "size",
      {
       "size": 150
      }
     ]
    ]
   },
   {
    "name": "Weight",
    "range": {
     "basedOn": "words"
    },
    "effects": [
     [
      "weight",
      {
       "weight": 400
      }
     ]
    ]
   },
   {
    "name": "Weight 800",
    "range": {
     "basedOn": "words"
    },
    "wiggle": {
     "rate": 0,
     "corr": 0,
     "seed": 4650,
     "pick": 50
    },
    "effects": [
     [
      "weight",
      {
       "weight": 800
      }
     ]
    ]
   },
   {
    "name": "Colour",
    "range": {
     "basedOn": "words"
    },
    "wiggle": {
     "rate": 0,
     "corr": 0,
     "seed": 4650,
     "pick": 40
    },
    "effects": [
     [
      "fill",
      {
       "color": "#33efab"
      }
     ]
    ]
   },
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
     "curve": "Smooth"
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
   "textRandomEnabled": false
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
    "name": "Size",
    "range": {
     "basedOn": "charsNoSpace"
    },
    "wiggle": {
     "rate": 0,
     "corr": 0,
     "seed": 6831,
     "max": 100,
     "min": -27
    },
    "effects": [
     [
      "size",
      {
       "size": 141
      }
     ]
    ]
   },
   {
    "name": "Weight",
    "range": {
     "basedOn": "charsNoSpace"
    },
    "effects": [
     [
      "weight",
      {
       "weight": 300
      }
     ]
    ]
   },
   {
    "name": "Weight 700",
    "range": {
     "basedOn": "charsNoSpace"
    },
    "wiggle": {
     "rate": 0,
     "corr": 0,
     "seed": 6831,
     "pick": 50
    },
    "effects": [
     [
      "weight",
      {
       "weight": 700
      }
     ]
    ]
   },
   {
    "name": "Italic",
    "range": {
     "basedOn": "charsNoSpace"
    },
    "wiggle": {
     "rate": 0,
     "corr": 0,
     "seed": 398,
     "pick": 25
    },
    "effects": [
     [
      "italic",
      {}
     ]
    ]
   },
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
     "curve": "Smooth"
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
     "curve": "Smooth"
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
   "textRandomEnabled": false
  }
 },
 {
  "id": "classic-random-rise",
  "name": "Random Rise",
  "cat": "classic-random",
  "description": "Masked rise; the words take random sizes and weights, some in one of two colours",
  "sides": "inOut",
  "anchor": "drive",
  "animators": [
   {
    "name": "Size",
    "range": {
     "basedOn": "words"
    },
    "wiggle": {
     "rate": 0,
     "corr": 0,
     "seed": 9726,
     "max": 100,
     "min": -25
    },
    "effects": [
     [
      "size",
      {
       "size": 140
      }
     ]
    ]
   },
   {
    "name": "Weight",
    "range": {
     "basedOn": "words"
    },
    "effects": [
     [
      "weight",
      {
       "weight": 500
      }
     ]
    ]
   },
   {
    "name": "Weight 900",
    "range": {
     "basedOn": "words"
    },
    "wiggle": {
     "rate": 0,
     "corr": 0,
     "seed": 9726,
     "pick": 50
    },
    "effects": [
     [
      "weight",
      {
       "weight": 900
      }
     ]
    ]
   },
   {
    "name": "Colour",
    "range": {
     "basedOn": "words"
    },
    "wiggle": {
     "rate": 0,
     "corr": 0,
     "seed": 9726,
     "pick": 45
    },
    "effects": [
     [
      "fill",
      {
       "color": "#7aa2ff"
      }
     ]
    ]
   },
   {
    "name": "Colour 2",
    "range": {
     "basedOn": "words",
     "randomize": true,
     "seed": 1,
     "start": 0,
     "end": 50,
     "smooth": 0
    },
    "wiggle": {
     "rate": 0,
     "corr": 0,
     "seed": 9726,
     "pick": 45
    },
    "effects": [
     [
      "fill",
      {
       "color": "#ff6b81"
      }
     ]
    ]
   },
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
     "curve": "Smooth"
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
     "curve": "Smooth"
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
   "textRandomEnabled": false
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
    "name": "Size",
    "range": {
     "basedOn": "charsNoSpace"
    },
    "wiggle": {
     "rate": 0,
     "corr": 0,
     "seed": 4232,
     "max": 100,
     "min": -38
    },
    "effects": [
     [
      "size",
      {
       "size": 165
      }
     ]
    ]
   },
   {
    "name": "Weight 700 · colour",
    "range": {
     "basedOn": "charsNoSpace"
    },
    "wiggle": {
     "rate": 0,
     "corr": 0,
     "seed": 4232,
     "pick": 60
    },
    "effects": [
     [
      "weight",
      {
       "weight": 700
      }
     ],
     [
      "fill",
      {
       "color": "#ffd166"
      }
     ]
    ]
   },
   {
    "name": "Weight 900",
    "range": {
     "basedOn": "charsNoSpace"
    },
    "wiggle": {
     "rate": 0,
     "corr": 0,
     "seed": 4232,
     "pick": 33.33
    },
    "effects": [
     [
      "weight",
      {
       "weight": 900
      }
     ]
    ]
   },
   {
    "name": "Colour 2",
    "range": {
     "basedOn": "charsNoSpace",
     "randomize": true,
     "seed": 2704,
     "start": 0,
     "end": 66.67,
     "smooth": 0
    },
    "wiggle": {
     "rate": 0,
     "corr": 0,
     "seed": 4232,
     "pick": 60
    },
    "effects": [
     [
      "fill",
      {
       "color": "#ff6b81"
      }
     ]
    ]
   },
   {
    "name": "Colour 3",
    "range": {
     "basedOn": "charsNoSpace",
     "randomize": true,
     "seed": 2704,
     "start": 0,
     "end": 33.33,
     "smooth": 0
    },
    "wiggle": {
     "rate": 0,
     "corr": 0,
     "seed": 4232,
     "pick": 60
    },
    "effects": [
     [
      "fill",
      {
       "color": "#7aa2ff"
      }
     ]
    ]
   },
   {
    "name": "Italic",
    "range": {
     "basedOn": "charsNoSpace"
    },
    "wiggle": {
     "rate": 0,
     "corr": 0,
     "seed": 4672,
     "pick": 30
    },
    "effects": [
     [
      "italic",
      {}
     ]
    ]
   },
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
     "curve": "Smooth"
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
   "textRandomEnabled": false
  }
 },
 {
  "id": "classic-editorial-typer",
  "name": "Editorial Typer",
  "cat": "classic-random",
  "description": "Word typing behind a caret, the words set in a mix of weights, sizes and italics",
  "sides": "inOut",
  "anchor": "drive",
  "animators": [
   {
    "name": "Size",
    "range": {
     "basedOn": "words"
    },
    "wiggle": {
     "rate": 0,
     "corr": 0,
     "seed": 5459,
     "max": 100,
     "min": -43
    },
    "effects": [
     [
      "size",
      {
       "size": 128
      }
     ]
    ]
   },
   {
    "name": "Weight",
    "range": {
     "basedOn": "words"
    },
    "effects": [
     [
      "weight",
      {
       "weight": 300
      }
     ]
    ]
   },
   {
    "name": "Weight 800",
    "range": {
     "basedOn": "words"
    },
    "wiggle": {
     "rate": 0,
     "corr": 0,
     "seed": 5459,
     "pick": 50
    },
    "effects": [
     [
      "weight",
      {
       "weight": 800
      }
     ]
    ]
   },
   {
    "name": "Italic",
    "range": {
     "basedOn": "words"
    },
    "wiggle": {
     "rate": 0,
     "corr": 0,
     "seed": 1,
     "pick": 35
    },
    "effects": [
     [
      "italic",
      {}
     ]
    ]
   },
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
     "curve": "Ease Out"
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
     "curve": "Ease In"
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
   "textRandomEnabled": false
  }
 }
];
