import { useEffect, useRef, useState } from 'react';
import ColorPicker from '../ColorPicker';
import GradientPicker from '../GradientPicker';
import { MediaInput } from '../GenerationInputField';
import {
  SHADER_PRESETS,
  SHADER_SCALES,
  getShaderPreset,
  drawShaderToContext,
  resolveShaderParams,
  shaderParamValues,
  shaderCodeFor,
} from '../../utils/shaderBackground';
// Own stylesheet: this component also renders outside the lazy MockupGenerator
// chunk (video editor background panel), where mockupGenerator.css isn't loaded.
import './backgroundSelector.css';

const API_BASE = import.meta.env.VITE_API_BASE_URL || '/api';
const MEDIA_BASE = API_BASE.replace(/\/api\/?$/, '');

function resolveMediaUrl(url) {
  if (!url) return null;
  return url.startsWith('http') || url.startsWith('data:') ? url : `${MEDIA_BASE}${url}`;
}

export const GRADIENT_PRESETS = [
  { id: 'sunburn', name: 'Sunburn', css: 'linear-gradient(135deg, #ffffc4 0.000%, #ff6164 50.000%, #b00012 100.000%)' },
  { id: 'flamingo', name: 'Flamingo', css: 'linear-gradient(45deg, #fada61 0.000%, #ff9188 50.000%, #ff5acd 100.000%)' },
  { id: 'aqua-lime', name: 'Aqua Lime', css: 'linear-gradient(90deg, #07aeea 0.000%, #2bf598 100.000%)' },
  { id: 'sunset-dusk', name: 'Sunset Dusk', css: 'linear-gradient(180deg, #ffffd1 0.000%, #ffae90 25.000%, #fb2654 50.000%, #be0028 75.000%, #801214 100.000%)' },
  { id: 'rose-mist', name: 'Rose Mist', css: 'linear-gradient(315deg, #f3f6e5 0.000%, #f8ece7 20.000%, #fcd9db 40.000%, #ffbccb 60.000%, #ff98c0 80.000%, #ff6bc2 100.000%)' },
  { id: 'violet-dream', name: 'Violet Dream', css: 'linear-gradient(135deg, #e1c3a7 0.000%, #d289e1 25.000%, #af37f6 50.000%, #7a00e4 75.000%, #3400ad 100.000%)' },
  { id: 'orchid', name: 'Orchid', css: 'linear-gradient(315deg, #eff0d3 0.000%, #ffe5e6 20.000%, #f5cce8 40.000%, #d9a3db 60.000%, #d76cbd 80.000%, #f3288f 100.000%)' },
  { id: 'neon-punch', name: 'Neon Punch', css: 'linear-gradient(180deg, #fe004b 0.000%, #ff0079 20.000%, #f42ba1 40.000%, #d65bc2 60.000%, #ad8bd9 80.000%, #81b8e6 100.000%)' },
  { id: 'grape-soda', name: 'Grape Soda', css: 'linear-gradient(270deg, #7900e6 0.000%, #9944ff 20.000%, #c296ff 40.000%, #e9c7ed 60.000%, #ffbdc2 80.000%, #ff7e8c 100.000%)' },
  { id: 'magenta-pop', name: 'Magenta Pop', css: 'linear-gradient(180deg, #4d3c86 0.000%, #6a1698 20.000%, #a314b6 40.000%, #dd37d3 60.000%, #ff78e4 80.000%, #fdcce3 100.000%)' },
  { id: 'tropic', name: 'Tropic', css: 'linear-gradient(135deg, #39cdcb 0.000%, #65cff1 20.000%, #9fb6ff 40.000%, #d589ff 60.000%, #f953f0 80.000%, #ff25c9 100.000%)' },
  { id: 'spectrum', name: 'Spectrum', css: 'linear-gradient(90deg, #19e5ec 0.000%, #43b0c4 16.667%, #806f8f 33.333%, #bf375a 50.000%, #ef1830 66.667%, #ff1b1c 83.333%, #f73f22 100.000%)' },
  { id: 'sky-deep', name: 'Sky Deep', css: 'linear-gradient(270deg, #bbd5fd 0.000%, #99b3ff 20.000%, #7790f1 40.000%, #556cce 60.000%, #3349a7 80.000%, #12268b 100.000%)' },
  { id: 'bubblegum', name: 'Bubblegum', css: 'linear-gradient(180deg, #ff70c3 0.000%, #e391d7 20.000%, #b4aaee 40.000%, #7cbbff 60.000%, #4bc4ff 80.000%, #2bc4fc 100.000%)' },
  { id: 'pastel-sky', name: 'Pastel Sky', css: 'linear-gradient(135deg, #ffd1e8 0.000%, #fdd1e8 9.091%, #f9d2ea 18.182%, #f3d4eb 27.273%, #ecd5ee 36.364%, #e4d7f1 45.455%, #dbdaf4 54.545%, #d3dcf8 63.636%, #cdddfa 72.727%, #c8dffd 81.818%, #c5e0fe 90.909%, #c4e0ff 100.000%)' },
  { id: 'ember-steps', name: 'Ember Steps', css: 'linear-gradient(90deg, #dac574 0.000%, #dac574 7.692%, #d9b656 calc(7.692% + 1px), #d9b656 15.385%, #d5a337 calc(15.385% + 1px), #d5a337 23.077%, #d08f17 calc(23.077% + 1px), #d08f17 30.769%, #c87900 calc(30.769% + 1px), #c87900 38.462%, #be6100 calc(38.462% + 1px), #be6100 46.154%, #b24800 calc(46.154% + 1px), #b24800 53.846%, #a52f00 calc(53.846% + 1px), #a52f00 61.538%, #961600 calc(61.538% + 1px), #961600 69.231%, #860000 calc(69.231% + 1px), #860000 76.923%, #740000 calc(76.923% + 1px), #740000 84.615%, #620000 calc(84.615% + 1px), #620000 92.308%, #500000 calc(92.308% + 1px) 100.000%)' },
  { id: 'blush-steps', name: 'Blush Steps', css: 'linear-gradient(90deg, #ffffff 0.000%, #ffffff 2.941%, #ffffff calc(2.941% + 1px), #ffffff 5.882%, #ffffff calc(5.882% + 1px), #ffffff 8.824%, #ffffff calc(8.824% + 1px), #ffffff 11.765%, #ffffff calc(11.765% + 1px), #ffffff 14.706%, #ffffff calc(14.706% + 1px), #ffffff 17.647%, #ffffff calc(17.647% + 1px), #ffffff 20.588%, #ffffff calc(20.588% + 1px), #ffffff 23.529%, #ffffff calc(23.529% + 1px), #ffffff 26.471%, #ffffff calc(26.471% + 1px), #ffffff 29.412%, #ffffff calc(29.412% + 1px), #ffffff 32.353%, #ffffff calc(32.353% + 1px), #ffffff 35.294%, #ffffff calc(35.294% + 1px), #ffffff 38.235%, #ffffff calc(38.235% + 1px), #ffffff 41.176%, #ffffff calc(41.176% + 1px), #ffffff 44.118%, #fff7ff calc(44.118% + 1px), #fff7ff 47.059%, #ffedff calc(47.059% + 1px), #ffedff 50.000%, #ffe3ff calc(50.000% + 1px), #ffe3ff 52.941%, #ffd9ff calc(52.941% + 1px), #ffd9ff 55.882%, #ffcfff calc(55.882% + 1px), #ffcfff 58.824%, #ffc5ff calc(58.824% + 1px), #ffc5ff 61.765%, #ffbcff calc(61.765% + 1px), #ffbcff 64.706%, #ffb2ff calc(64.706% + 1px), #ffb2ff 67.647%, #ffa9ff calc(67.647% + 1px), #ffa9ff 70.588%, #ffa0ff calc(70.588% + 1px), #ffa0ff 73.529%, #ff97ff calc(73.529% + 1px), #ff97ff 76.471%, #f98fff calc(76.471% + 1px), #f98fff 79.412%, #ed87ff calc(79.412% + 1px), #ed87ff 82.353%, #e17fff calc(82.353% + 1px), #e17fff 85.294%, #d478ff calc(85.294% + 1px), #d478ff 88.235%, #c871ff calc(88.235% + 1px), #c871ff 91.176%, #bb6bff calc(91.176% + 1px), #bb6bff 94.118%, #af65ff calc(94.118% + 1px), #af65ff 97.059%, #a35fff calc(97.059% + 1px) 100.000%)' },
  { id: 'earth-sea', name: 'Earth & Sea', css: 'linear-gradient(90deg, #c8d5c8 0.000%, #c8d5c8 2.941%, #d0d3bd calc(2.941% + 1px), #d0d3bd 5.882%, #d4ceaf calc(5.882% + 1px), #d4ceaf 8.824%, #d5c59e calc(8.824% + 1px), #d5c59e 11.765%, #d2b88c calc(11.765% + 1px), #d2b88c 14.706%, #cbaa79 calc(14.706% + 1px), #cbaa79 17.647%, #c19865 calc(17.647% + 1px), #c19865 20.588%, #b48651 calc(20.588% + 1px), #b48651 23.529%, #a5723f calc(23.529% + 1px), #a5723f 26.471%, #935f2e calc(26.471% + 1px), #935f2e 29.412%, #804b20 calc(29.412% + 1px), #804b20 32.353%, #6c3914 calc(32.353% + 1px), #6c3914 35.294%, #59290b calc(35.294% + 1px), #59290b 38.235%, #461c06 calc(38.235% + 1px), #461c06 41.176%, #341105 calc(41.176% + 1px), #341105 44.118%, #250908 calc(44.118% + 1px), #250908 47.059%, #18060e calc(47.059% + 1px), #18060e 50.000%, #0e0617 calc(50.000% + 1px), #0e0617 52.941%, #080924 calc(52.941% + 1px), #080924 55.882%, #051033 calc(55.882% + 1px), #051033 58.824%, #061b45 calc(58.824% + 1px), #061b45 61.765%, #0b2958 calc(61.765% + 1px), #0b2958 64.706%, #13396b calc(64.706% + 1px), #13396b 67.647%, #1f4b7f calc(67.647% + 1px), #1f4b7f 70.588%, #2d5e92 calc(70.588% + 1px), #2d5e92 73.529%, #3e72a4 calc(73.529% + 1px), #3e72a4 76.471%, #5085b3 calc(76.471% + 1px), #5085b3 79.412%, #6498c1 calc(79.412% + 1px), #6498c1 82.353%, #77a9cb calc(82.353% + 1px), #77a9cb 85.294%, #8bb8d2 calc(85.294% + 1px), #8bb8d2 88.235%, #9dc4d5 calc(88.235% + 1px), #9dc4d5 91.176%, #aecdd4 calc(91.176% + 1px), #aecdd4 94.118%, #bcd3d0 calc(94.118% + 1px), #bcd3d0 97.059%, #c7d5c8 calc(97.059% + 1px) 100.000%)' },
  { id: 'indigo-sand', name: 'Indigo Sand', css: 'linear-gradient(315deg, #110087 0.000%, #110087 4.762%, #120091 calc(4.762% + 1px), #120091 9.524%, #14009a calc(9.524% + 1px), #14009a 14.286%, #1700a2 calc(14.286% + 1px), #1700a2 19.048%, #1c11a9 calc(19.048% + 1px), #1c11a9 23.810%, #2322b0 calc(23.810% + 1px), #2322b0 28.571%, #2a33b5 calc(28.571% + 1px), #2a33b5 33.333%, #3343b9 calc(33.333% + 1px), #3343b9 38.095%, #3e52bb calc(38.095% + 1px), #3e52bb 42.857%, #485fbd calc(42.857% + 1px), #485fbd 47.619%, #546dbe calc(47.619% + 1px), #546dbe 52.381%, #6079be calc(52.381% + 1px), #6079be 57.143%, #6d84bc calc(57.143% + 1px), #6d84bc 61.905%, #7a8eba calc(61.905% + 1px), #7a8eba 66.667%, #8697b6 calc(66.667% + 1px), #8697b6 71.429%, #93a0b2 calc(71.429% + 1px), #93a0b2 76.190%, #9ea7ac calc(76.190% + 1px), #9ea7ac 80.952%, #aaada5 calc(80.952% + 1px), #aaada5 85.714%, #b4b29d calc(85.714% + 1px), #b4b29d 90.476%, #bdb795 calc(90.476% + 1px), #bdb795 95.238%, #c5ba8b calc(95.238% + 1px) 100.000%)' },
  { id: 'cotton-candy', name: 'Cotton Candy', css: 'linear-gradient(90deg, #f59eb6 0.000%, #f59eb6 7.692%, #fca8b7 calc(7.692% + 1px), #fca8b7 15.385%, #ffb3bc calc(15.385% + 1px), #ffb3bc 23.077%, #ffbec4 calc(23.077% + 1px), #ffbec4 30.769%, #ffc6ce calc(30.769% + 1px), #ffc6ce 38.462%, #feccd9 calc(38.462% + 1px), #feccd9 46.154%, #f8cee4 calc(46.154% + 1px), #f8cee4 53.846%, #f1cdef calc(53.846% + 1px), #f1cdef 61.538%, #e7c9f8 calc(61.538% + 1px), #e7c9f8 69.231%, #ddc1fe calc(69.231% + 1px), #ddc1fe 76.923%, #d2b7ff calc(76.923% + 1px), #d2b7ff 84.615%, #c6acff calc(84.615% + 1px), #c6acff 92.308%, #bca1ff calc(92.308% + 1px) 100.000%)' },
];

// The refreshed picker intentionally shows only the new palette, but persisted
// projects can still reference the former IDs. Keep those renders stable.
const LEGACY_GRADIENT_CSS = {
  sunset: 'linear-gradient(135deg, #ff6b6b 0%, #feca57 50%, #ff9ff3 100%)',
  ocean: 'linear-gradient(135deg, #667eea 0%, #764ba2 50%, #f093fb 100%)',
  forest: 'linear-gradient(135deg, #11998e 0%, #38ef7d 100%)',
  midnight: 'linear-gradient(135deg, #0c0c0c 0%, #1a1a2e 50%, #16213e 100%)',
  neon: 'linear-gradient(135deg, #f72585 0%, #7209b7 50%, #3a0ca3 100%)',
  aurora: 'linear-gradient(135deg, #00d2d3 0%, #9b59b6 50%, #f39c12 100%)',
  fire: 'linear-gradient(135deg, #f12711 0%, #f5af19 100%)',
  'cool-blue': 'linear-gradient(135deg, #2193b0 0%, #6dd5ed 100%)',
  'purple-haze': 'linear-gradient(135deg, #7303c0 0%, #ec38bc 50%, #fdeff9 100%)',
  emerald: 'linear-gradient(135deg, #134e5e 0%, #71b280 100%)',
  candy: 'linear-gradient(135deg, #ff0844 0%, #ffb199 100%)',
  cosmic: 'linear-gradient(135deg, #0f0c29 0%, #302b63 50%, #24243e 100%)',
  citrus: 'linear-gradient(135deg, #f7971e 0%, #ffd200 100%)',
  berry: 'linear-gradient(135deg, #8e2de2 0%, #4a00e0 100%)',
  mint: 'linear-gradient(135deg, #00b09b 0%, #96c93d 100%)',
  steel: 'linear-gradient(135deg, #485563 0%, #29323c 100%)',
  sunrise: 'linear-gradient(135deg, #f093fb 0%, #f5576c 50%, #ffd34e 100%)',
  ice: 'linear-gradient(135deg, #74ebd5 0%, #9face6 100%)',
  royal: 'linear-gradient(135deg, #141e30 0%, #243b55 100%)',
  rainbow: 'linear-gradient(135deg, #f72585 0%, #7209b7 20%, #3a0ca3 40%, #4361ee 60%, #4cc9f0 80%, #06d6a0 100%)',
};

function gradientCssForId(id) {
  return GRADIENT_PRESETS.find((preset) => preset.id === id)?.css
    || LEGACY_GRADIENT_CSS[id];
}

export const PATTERN_PRESETS = [
  { id: 'dots', name: 'Dots', svg: (c) => `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><circle cx="10" cy="10" r="2" fill="${c}"/></svg>` },
  { id: 'grid', name: 'Grid', svg: (c) => `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><path d="M 20 0 L 0 0 0 20" fill="none" stroke="${c}" stroke-width="0.5"/></svg>` },
  { id: 'diagonal', name: 'Diagonal Lines', svg: (c) => `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><path d="M-1,1 l2,-2 M0,10 l10,-10 M9,11 l2,-2" stroke="${c}" stroke-width="1"/></svg>` },
  { id: 'zigzag', name: 'Zigzag', svg: (c) => `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="10"><path d="M0 5 L5 0 L10 5 L15 0 L20 5" fill="none" stroke="${c}" stroke-width="1"/></svg>` },
  { id: 'crosses', name: 'Crosses', svg: (c) => `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><path d="M10 5 L10 15 M5 10 L15 10" stroke="${c}" stroke-width="1"/></svg>` },
  { id: 'triangles', name: 'Triangles', svg: (c) => `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><polygon points="10,2 18,18 2,18" fill="none" stroke="${c}" stroke-width="1"/></svg>` },
  { id: 'hexagons', name: 'Hexagons', svg: (c) => `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="24"><polygon points="14,2 26,8 26,18 14,24 2,18 2,8" fill="none" stroke="${c}" stroke-width="1"/></svg>` },
  { id: 'diamonds', name: 'Diamonds', svg: (c) => `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><polygon points="10,2 18,10 10,18 2,10" fill="none" stroke="${c}" stroke-width="1"/></svg>` },
  { id: 'waves', name: 'Waves', svg: (c) => `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="10"><path d="M0 5 Q10 0 20 5 T40 5" fill="none" stroke="${c}" stroke-width="1"/></svg>` },
  { id: 'circles', name: 'Circles', svg: (c) => `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><circle cx="10" cy="10" r="6" fill="none" stroke="${c}" stroke-width="1"/></svg>` },
  { id: 'squares', name: 'Squares', svg: (c) => `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect x="4" y="4" width="12" height="12" fill="none" stroke="${c}" stroke-width="1"/></svg>` },
  { id: 'stars', name: 'Stars', svg: (c) => `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><polygon points="12,2 15,9 22,9 16,14 18,22 12,18 6,22 8,14 2,9 9,9" fill="${c}"/></svg>` },
  { id: 'stripes-h', name: 'Horizontal Stripes', svg: (c) => `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="5" fill="${c}"/></svg>` },
  { id: 'stripes-v', name: 'Vertical Stripes', svg: (c) => `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="5" height="10" fill="${c}"/></svg>` },
  { id: 'checkers', name: 'Checkers', svg: (c) => `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="10" height="10" fill="${c}"/><rect x="10" y="10" width="10" height="10" fill="${c}"/></svg>` },
  { id: 'confetti', name: 'Confetti', svg: (c) => `<svg xmlns="http://www.w3.org/2000/svg" width="30" height="30"><rect x="5" y="5" width="3" height="3" fill="${c}" transform="rotate(15 6.5 6.5)"/><rect x="20" y="15" width="4" height="2" fill="${c}" transform="rotate(-20 22 16)"/><rect x="10" y="22" width="2" height="4" fill="${c}" transform="rotate(30 11 24)"/></svg>` },
  { id: 'plus', name: 'Plus Signs', svg: (c) => `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><path d="M8 4 h4 v4 h4 v4 h-4 v4 h-4 v-4 h-4 v-4 h4 z" fill="${c}"/></svg>` },
  { id: 'arrows', name: 'Arrows', svg: (c) => `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><path d="M10 3 L16 10 L13 10 L13 17 L7 17 L7 10 L4 10 Z" fill="${c}"/></svg>` },
  { id: 'hearts', name: 'Hearts', svg: (c) => `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><path d="M12 21 C12 21 3 14 3 8 C3 5 5 3 8 3 C10 3 12 5 12 5 C12 5 14 3 16 3 C19 3 21 5 21 8 C21 14 12 21 12 21" fill="${c}"/></svg>` },
  { id: 'noise', name: 'Noise', svg: (c) => `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect x="2" y="5" width="1" height="1" fill="${c}"/><rect x="15" y="2" width="1" height="1" fill="${c}"/><rect x="28" y="8" width="1" height="1" fill="${c}"/><rect x="8" y="18" width="1" height="1" fill="${c}"/><rect x="22" y="15" width="1" height="1" fill="${c}"/><rect x="35" y="20" width="1" height="1" fill="${c}"/><rect x="5" y="30" width="1" height="1" fill="${c}"/><rect x="18" y="35" width="1" height="1" fill="${c}"/><rect x="32" y="28" width="1" height="1" fill="${c}"/><rect x="12" y="25" width="1" height="1" fill="${c}"/><rect x="38" y="38" width="1" height="1" fill="${c}"/></svg>` },
  { id: 'scallops', name: 'Scallops', svg: (c) => `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><path d="M0 20 Q5 10 10 20 Q15 10 20 20" fill="none" stroke="${c}" stroke-width="1"/></svg>` },
  { id: 'brick', name: 'Brick', svg: (c) => `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="40" height="20" fill="none" stroke="${c}" stroke-width="0.5"/><line x1="20" y1="0" x2="20" y2="10" stroke="${c}" stroke-width="0.5"/><line x1="0" y1="10" x2="40" y2="10" stroke="${c}" stroke-width="0.5"/><line x1="0" y1="10" x2="0" y2="20" stroke="${c}" stroke-width="0.5"/><line x1="40" y1="10" x2="40" y2="20" stroke="${c}" stroke-width="0.5"/></svg>` },
  { id: 'leaf', name: 'Leaves', svg: (c) => `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><path d="M12 4 Q18 8 12 20 Q6 8 12 4 Z" fill="none" stroke="${c}" stroke-width="1"/></svg>` },
  { id: 'spiral', name: 'Spirals', svg: (c) => `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><path d="M12 8 A4 4 0 1 1 12 16 A2 2 0 1 0 12 12" fill="none" stroke="${c}" stroke-width="1"/></svg>` },
  { id: 'cross-hatch', name: 'Cross Hatch', svg: (c) => `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><path d="M0 0 L10 10 M10 0 L0 10" stroke="${c}" stroke-width="0.5"/></svg>` },
  { id: 'rings', name: 'Rings', svg: (c) => `<svg xmlns="http://www.w3.org/2000/svg" width="30" height="30"><circle cx="15" cy="15" r="10" fill="none" stroke="${c}" stroke-width="0.8"/><circle cx="15" cy="15" r="5" fill="none" stroke="${c}" stroke-width="0.8"/></svg>` },
  { id: 'fish-scale', name: 'Fish Scale', svg: (c) => `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><path d="M0 10 A10 10 0 0 1 20 10" fill="none" stroke="${c}" stroke-width="0.8"/><path d="M10 20 A10 10 0 0 1 30 20" fill="none" stroke="${c}" stroke-width="0.8" transform="translate(-10,0)"/></svg>` },
  { id: 'moon', name: 'Moons', svg: (c) => `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><path d="M15 4 A8 8 0 1 0 15 20 A6 6 0 0 1 15 4" fill="none" stroke="${c}" stroke-width="1"/></svg>` },
  { id: 'dashes', name: 'Dashes', svg: (c) => `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><line x1="4" y1="10" x2="16" y2="10" stroke="${c}" stroke-width="2" stroke-linecap="round"/></svg>` },
  { id: 'polka-ring', name: 'Polka Rings', svg: (c) => `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><circle cx="12" cy="12" r="4" fill="none" stroke="${c}" stroke-width="1.5"/></svg>` },
];

function getPatternBg(svgMarkup, scalePercent, bgColor) {
  const wMatch = svgMarkup.match(/width="([\d.]+)"/);
  const hMatch = svgMarkup.match(/height="([\d.]+)"/);
  const bw = Number(wMatch?.[1] || 20);
  const bh = Number(hMatch?.[1] || 20);
  const s = scalePercent / 100;
  const data = encodeURIComponent(svgMarkup);
  return `url("data:image/svg+xml,${data}") 0 0 / ${Math.max(1, bw * s)}px ${Math.max(1, bh * s)}px repeat, ${bgColor}`;
}

export function getBackgroundCSS(config, baseBg) {
  if (!config) return baseBg || '#050505';
  switch (config.type) {
    case 'solid': return config.solidColor || baseBg || '#050505';
    case 'gradient': {
      if (config.gradientCss) return config.gradientCss;
      return gradientCssForId(config.gradientId) || GRADIENT_PRESETS[0].css;
    }
    // Shaders can't be expressed as a CSS background — the canvas layer draws
    // them (drawEditorBackground). This base color sits behind on failure.
    case 'shader': return config.solidColor || baseBg || '#050505';
    case 'pattern': {
      const p = PATTERN_PRESETS.find(x => x.id === config.patternId);
      const pc = config.patternColor || '#ffffff';
      const bc = config.solidColor || baseBg || '#050505';
      return p ? getPatternBg(p.svg(pc), config.patternScale || 100, bc) : bc;
    }
    case 'image': {
      const url = config.mediaUrl;
      const base = config.solidColor || baseBg || '#050505';
      if (!url) return base;
      const size = config.bgFit === 'custom' ? `${config.bgScale ?? 100}%` : (config.bgFit || 'cover');
      const px = config.bgPosX ?? 50;
      const py = config.bgPosY ?? 50;
      const repeat = config.bgRepeat || 'no-repeat';
      return `url("${url}") ${px}% ${py}% / ${size} ${repeat}, ${base}`;
    }
    // Video can't be a CSS background — the preview/render draws it as a layer;
    // this base color sits behind it (and shows through letterboxing).
    case 'video': return config.solidColor || baseBg || '#050505';
    case 'transparent': return 'transparent';
    default: return baseBg || '#050505';
  }
}

export function requiresAlphaChannel(config) {
  return config?.type === 'transparent';
}

// Draw an image/video element as a background layer, reproducing the CSS
// background (fit=cover/contain/custom, position %, and image repeat/tiling).
// Shared by the headless export and the live preview so they match exactly.
export function drawBackgroundMedia(ctx, W, H, media, config) {
  const sw = media.videoWidth || media.naturalWidth || media.width;
  const sh = media.videoHeight || media.naturalHeight || media.height;
  if (!sw || !sh) return;
  const fit = config.bgFit || 'cover';
  let dw;
  let dh;
  if (fit === 'contain') {
    const s = Math.min(W / sw, H / sh); dw = sw * s; dh = sh * s;
  } else if (fit === 'custom') {
    dw = W * ((config.bgScale ?? 100) / 100); dh = dw * (sh / sw);
  } else {
    const s = Math.max(W / sw, H / sh); dw = sw * s; dh = sh * s;
  }
  const posX = (config.bgPosX ?? 50) / 100;
  const posY = (config.bgPosY ?? 50) / 100;
  const x = (W - dw) * posX;
  const y = (H - dh) * posY;

  const repeat = config.type === 'image' ? (config.bgRepeat || 'no-repeat') : 'no-repeat';
  const tileX = repeat === 'repeat' || repeat === 'repeat-x';
  const tileY = repeat === 'repeat' || repeat === 'repeat-y';

  const xs = [];
  if (tileX) { for (let sx = x - Math.ceil(x / dw) * dw; sx < W; sx += dw) xs.push(sx); }
  else xs.push(x);
  const ys = [];
  if (tileY) { for (let sy = y - Math.ceil(y / dh) * dh; sy < H; sy += dh) ys.push(sy); }
  else ys.push(y);
  for (const yy of ys) for (const xx of xs) ctx.drawImage(media, xx, yy, dw, dh);
}

// Resolve the effective gradient CSS for a config: a custom picker string wins,
// then a named preset, then the first preset.
export function resolveGradientCss(config) {
  if (config?.gradientCss) return config.gradientCss;
  return gradientCssForId(config?.gradientId) || GRADIENT_PRESETS[0].css;
}

// User-saved gradient presets (per machine, shared by the video editor and the
// mockup builder). Presets are a picker convenience only — the chosen gradient
// is stored on the config as gradientCss, so exports never need this list.
const CUSTOM_GRADIENTS_KEY = 'gl_custom_gradient_presets';

function readCustomGradients() {
  try {
    const raw = JSON.parse(localStorage.getItem(CUSTOM_GRADIENTS_KEY) || '[]');
    return Array.isArray(raw)
      ? raw.filter((g) => g && typeof g.id === 'string' && typeof g.css === 'string')
      : [];
  } catch {
    return [];
  }
}

// Live, animated GLSL preview thumbnail. Renders on its own rAF loop (wall clock)
// — this is preview-only; the exported/rendered frames are deterministic from the
// player time. setError bails out of re-render unless the compile status changes.
// The preview must render into the same size BUFFER the background will use,
// not into a thumbnail-sized one: a shader working in pixel units draws the
// same absolute number of pixels whatever the canvas is, so a 320px preview
// makes a sparse shader look dense and hides that it will vanish at 1080p.
// Referenced to a 1080p frame (the panel doesn't know the project size) and
// capped so "Full" can't put a 1920-wide rAF loop in a settings panel — every
// reduced setting lands on the real buffer size exactly.
const PREVIEW_REF_W = 1920;
const PREVIEW_MAX_W = 1280;

// A preset's looks are named param sets; the one matching the current values is
// shown as picked. Hex compares case-insensitively, numbers within float noise.
const sameParam = (a, b) => (typeof a === 'string' || typeof b === 'string')
  ? String(a).toLowerCase() === String(b).toLowerCase()
  : Math.abs(Number(a) - Number(b)) < 1e-6;
function activeLookIndex(preset, values) {
  if (!preset?.looks?.length) return -1;
  return preset.looks.findIndex((l) => Object.keys(l.values).every((k) => sameParam(values[k], l.values[k])));
}
// Swatch for a look chip: its first three distinct colours as a soft diagonal.
function lookSwatch(preset, look) {
  const cols = preset.params.filter((d) => d.type === 'color')
    .map((d) => String(look.values[d.key] ?? d.default).toLowerCase());
  const uniq = [...new Set(cols)].slice(0, 3);
  if (uniq.length < 2) return uniq[0] || '#888';
  return `linear-gradient(135deg, ${uniq.map((c, i) => `${c} ${Math.round((i * 100) / (uniq.length - 1))}%`).join(', ')})`;
}

function ShaderPreview({ code, speed, scale, zoom, params }) {
  const canvasRef = useRef(null);
  const [error, setError] = useState(null);
  const bufW = Math.max(160, Math.min(PREVIEW_MAX_W, Math.round(PREVIEW_REF_W * (scale ?? 1))));
  const bufH = Math.round((bufW * 9) / 16);
  // Params/zoom ride on a ref so a colour-picker drag doesn't restart the rAF
  // loop (and lose the animation clock) every change — the loop reads them live.
  const liveRef = useRef({ zoom, params });
  useEffect(() => { liveRef.current = { zoom, params }; });
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const ctx = canvas.getContext('2d');
    let raf = 0;
    let start = null;
    const loop = (ts) => {
      if (start == null) start = ts;
      const t = ((ts - start) / 1000) * (speed ?? 1);
      const err = drawShaderToContext(ctx, canvas.width, canvas.height, code, t, {
        usageKey: 'bg-preview',
        maxDim: canvas.width,
        zoom: liveRef.current.zoom,
        params: liveRef.current.params,
      });
      setError((prev) => (prev === err ? prev : err));
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [code, speed, bufW, bufH]);
  return (
    <div className="glvr-option-field">
      <canvas
        ref={canvasRef}
        width={bufW}
        height={bufH}
        style={{ width: '100%', borderRadius: 8, display: 'block', background: '#111' }}
      />
      {error && (
        <div className="mg-info" style={{ color: '#ff9a9a', whiteSpace: 'pre-wrap', fontSize: 11, marginTop: 6 }}>
          {String(error).slice(0, 400)}
        </div>
      )}
    </div>
  );
}

export default function BackgroundSelector({
  value,
  onChange,
  defaultColor = '#050505',
  elements = [],
  allowMedia = false,
  allowVideo = allowMedia,
  advanced = false,
  // Optional keyframe stopwatch (video editor only): rendered beside the Color /
  // Gradient labels; `fillLocked` greys the pickers while a track drives the fill.
  fillAction = null,
  fillLocked = false,
}) {
  // Stay controlled so undo/redo, project switches, and preset resets cannot
  // leave the panel editing a stale local copy.
  const config = value || { type: 'solid', solidColor: defaultColor };

  const update = (u) => {
    const next = { ...config, ...u };
    onChange(next);
  };

  const [customGradients, setCustomGradients] = useState(readCustomGradients);
  const persistCustomGradients = (list) => {
    setCustomGradients(list);
    try { localStorage.setItem(CUSTOM_GRADIENTS_KEY, JSON.stringify(list)); } catch { /* full/blocked */ }
  };
  const currentGradientCss = resolveGradientCss(config);
  const gradientAlreadySaved =
    GRADIENT_PRESETS.some((g) => g.css === currentGradientCss)
    || customGradients.some((g) => g.css === currentGradientCss);
  const saveCurrentGradient = () => {
    if (!currentGradientCss || gradientAlreadySaved) return;
    persistCustomGradients([
      ...customGradients,
      { id: `custom-${Date.now()}`, name: `Custom ${customGradients.length + 1}`, css: currentGradientCss },
    ]);
  };
  const removeCustomGradient = (id) => {
    persistCustomGradients(customGradients.filter((g) => g.id !== id));
  };

  // Seed type-specific defaults when switching into gradient/shader.
  const onTypeChange = (type) => {
    const patch = { type };
    if (type === 'gradient' && !config.gradientCss) patch.gradientCss = resolveGradientCss(config);
    if (type === 'shader' && !config.shaderCode) {
      patch.shaderId = SHADER_PRESETS[0].id;
      patch.shaderCode = SHADER_PRESETS[0].code;
    }
    update(patch);
  };

  const isMedia = config.type === 'image' || config.type === 'video';

  return (
    <div className="mg-bg-selector">
      <div className="glvr-option-field">
        <label className="glvr-option-label">Type</label>
        <select className="glvr-select" value={config.type} onChange={(e) => onTypeChange(e.target.value)}>
          <option value="solid">Solid Color</option>
          <option value="gradient">Gradient</option>
          {advanced && <option value="shader">Shader</option>}
          <option value="pattern">Pattern</option>
          {allowMedia && <option value="image">Image</option>}
          {allowMedia && (allowVideo || config.type === 'video') && <option value="video">Video</option>}
          <option value="transparent">Transparent</option>
        </select>
      </div>

      {isMedia && (
        <>
          <div className="glvr-option-field">
            <label className="glvr-option-label">{config.type === 'video' ? 'Background Video' : 'Background Image'}</label>
            <MediaInput
              fieldType={config.type === 'video' ? 'video' : 'image'}
              value={config.mediaUrl || ''}
              onChange={(url) => {
                if (url) {
                  const resolved = resolveMediaUrl(url);
                  update({ mediaUrl: resolved || url, mediaType: config.type });
                } else {
                  update({ mediaUrl: '' });
                }
              }}
              elements={elements}
              unsortedItems={[]}
              popoverPlacement="bottom-left"
            />
          </div>
          <div className="glvr-option-field">
            <label className="glvr-option-label">Fit</label>
            <select className="glvr-select" value={config.bgFit || 'cover'} onChange={(e) => update({ bgFit: e.target.value })}>
              <option value="cover">Cover (fill)</option>
              <option value="contain">Contain (fit)</option>
              <option value="custom">Custom scale</option>
            </select>
          </div>
          {config.bgFit === 'custom' && (
            <div className="glvr-option-field">
              <label className="glvr-option-label">Scale: {config.bgScale ?? 100}%</label>
              <input type="range" className="mg-range" min={10} max={400} step={5}
                value={config.bgScale ?? 100} onChange={(e) => update({ bgScale: Number(e.target.value) })} />
            </div>
          )}
          <div className="glvr-option-field">
            <label className="glvr-option-label">Position X: {config.bgPosX ?? 50}%</label>
            <input type="range" className="mg-range" min={0} max={100} step={1}
              value={config.bgPosX ?? 50} onChange={(e) => update({ bgPosX: Number(e.target.value) })} />
          </div>
          <div className="glvr-option-field">
            <label className="glvr-option-label">Position Y: {config.bgPosY ?? 50}%</label>
            <input type="range" className="mg-range" min={0} max={100} step={1}
              value={config.bgPosY ?? 50} onChange={(e) => update({ bgPosY: Number(e.target.value) })} />
          </div>
          {config.type === 'image' && (
            <div className="glvr-option-field">
              <label className="glvr-option-label">Repeat</label>
              <select className="glvr-select" value={config.bgRepeat || 'no-repeat'} onChange={(e) => update({ bgRepeat: e.target.value })}>
                <option value="no-repeat">No repeat</option>
                <option value="repeat">Tile</option>
                <option value="repeat-x">Tile horizontally</option>
                <option value="repeat-y">Tile vertically</option>
              </select>
            </div>
          )}
          <div className="glvr-option-field">
            <label className="glvr-option-label">Base Color</label>
            <ColorPicker value={config.solidColor || defaultColor} onChange={(v) => update({ solidColor: v })} withAlpha />
          </div>
        </>
      )}

      {config.type === 'solid' && (
        <div className="glvr-option-field">
          <label className="glvr-option-label" style={fillAction ? { display: 'inline-flex', alignItems: 'center', gap: 5 } : undefined}>
            Color
            {fillAction}
          </label>
          <div
            className={fillLocked ? 've-motion-field-kf-locked' : undefined}
            title={fillLocked ? 'Controlled by keyframes' : undefined}
          >
            <ColorPicker value={config.solidColor || defaultColor} onChange={(v) => update({ solidColor: v })} withAlpha />
          </div>
        </div>
      )}

      {/* Same gradient editor everywhere; only the animated toggle is
          advanced-only (the mockup canvas draws gradients statically). */}
      {config.type === 'gradient' && (
        <>
          <div className="glvr-option-field">
            <div className="mg-preset-head">
              <label className="glvr-option-label" style={fillAction ? { display: 'inline-flex', alignItems: 'center', gap: 5 } : undefined}>
                Gradient
                {fillAction}
              </label>
              <button
                type="button"
                className="mg-preset-save-btn"
                onClick={saveCurrentGradient}
                disabled={gradientAlreadySaved}
                title={gradientAlreadySaved ? 'This gradient is already a preset' : 'Save the current gradient as a preset'}
              >
                {gradientAlreadySaved ? 'Saved' : 'Save'}
              </button>
            </div>
            <div
              className={fillLocked ? 've-motion-field-kf-locked' : undefined}
              title={fillLocked ? 'Controlled by keyframes' : undefined}
            >
              <GradientPicker
                value={resolveGradientCss(config)}
                onChange={(css) => update({ gradientCss: css, gradientId: null })}
                popoverPlacement="start"
              />
            </div>
          </div>
          <div className="glvr-option-field">
            <label className="glvr-option-label">Presets</label>
            <div className={`mg-grid-4${fillLocked ? ' ve-motion-field-kf-locked' : ''}`}>
              {GRADIENT_PRESETS.map((g) => (
                <button
                  key={g.id}
                  className={`mg-swatch ${config.gradientCss === g.css ? 'active' : ''}`}
                  style={{ background: g.css }}
                  onClick={() => update({ gradientCss: g.css, gradientId: g.id })}
                  title={g.name}
                />
              ))}
              {customGradients.map((g) => (
                <div key={g.id} className="mg-swatch-wrap">
                  <button
                    className={`mg-swatch ${config.gradientCss === g.css ? 'active' : ''}`}
                    style={{ background: g.css }}
                    onClick={() => update({ gradientCss: g.css, gradientId: g.id })}
                    title={g.name || 'Custom gradient'}
                  />
                  <button
                    type="button"
                    className="mg-swatch-x"
                    onClick={() => removeCustomGradient(g.id)}
                    title="Remove this preset"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          </div>
          {advanced && (
            <>
              <label className="ve-dof-row ve-dof-row-toggle" style={{ marginTop: 10 }}>
                <span
                  className={`ve-dof-switch-track${config.gradientAnimated ? ' active' : ''}`}
                  onClick={() => update({ gradientAnimated: !config.gradientAnimated })}
                >
                  <span className="ve-dof-switch-thumb" />
                </span>
                <span>Animated gradient</span>
              </label>
              {config.gradientAnimated && (
                <div className="glvr-option-field">
                  <label className="glvr-option-label">Speed: {(config.gradientAnimSpeed ?? 1).toFixed(1)}×</label>
                  <input type="range" className="mg-range" min={0.1} max={4} step={0.1}
                    value={config.gradientAnimSpeed ?? 1} onChange={(e) => update({ gradientAnimSpeed: Number(e.target.value) })} />
                </div>
              )}
            </>
          )}
        </>
      )}

      {config.type === 'shader' && advanced && (
        <>
          <div className="glvr-option-field">
            <label className="glvr-option-label">Preset</label>
            <select
              className="glvr-select"
              value={config.shaderId || SHADER_PRESETS[0].id}
              onChange={(e) => {
                const preset = getShaderPreset(e.target.value);
                // Params reset with the preset — stale keys from the previous
                // preset must not leak into the new one's uniforms.
                if (preset) update({ shaderId: preset.id, shaderCode: preset.code, shaderParams: {}, shaderLook: null });
              }}
            >
              {/* PRESETS ONLY. Hand-written shader source is no longer an input:
                  see the code-editor removal below. A project saved with custom
                  code still RENDERS it — nothing is thrown away — it simply is
                  not editable, and picking a preset replaces it. */}
              {SHADER_PRESETS.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
          <ShaderPreview
            code={shaderCodeFor(config)}
            speed={config.shaderSpeed ?? 1}
            scale={config.shaderScale ?? 1}
            zoom={config.shaderZoom ?? 1}
            params={resolveShaderParams(config)}
          />
          {(() => {
            const preset = getShaderPreset(config.shaderId);
            if (!preset?.looks || preset.looks.length < 2) return null;
            const values = shaderParamValues(config);
            const active = activeLookIndex(preset, values);
            return (
              <div className="glvr-option-field">
                <label className="glvr-option-label">Presets</label>
                <div className="mg-look-row">
                  {preset.looks.map((look, i) => (
                    <button
                      key={look.id || look.name}
                      type="button"
                      className={`mg-look-chip${i === active ? ' active' : ''}`}
                      // The look is stored by id (shaderParamValues resolves it), so its
                      // values are not copied into the project; picking one clears the
                      // per-param overrides that sat on top of the previous look.
                      onClick={() => update({ shaderLook: look.id, shaderParams: {} })}
                      title={look.name}
                    >
                      <span className="mg-look-sw" style={{ background: lookSwatch(preset, look) }} />
                      {look.name}
                    </button>
                  ))}
                </div>
              </div>
            );
          })()}
          {(getShaderPreset(config.shaderId)?.params || []).map((def) => {
            const values = shaderParamValues(config);
            const val = values[def.key];
            const setParam = (v) => update({ shaderParams: { ...values, [def.key]: v } });
            if (def.type === 'select') {
              return (
                <div className="glvr-option-field" key={def.key}>
                  <label className="glvr-option-label">{def.label}</label>
                  <select className="glvr-select" value={String(Number(val ?? def.default))}
                    onChange={(e) => setParam(Number(e.target.value))}>
                    {def.options.map((o) => <option key={o.value} value={String(o.value)}>{o.label}</option>)}
                  </select>
                </div>
              );
            }
            if (def.type === 'color') {
              return (
                <div className="glvr-option-field" key={def.key}>
                  <label className="glvr-option-label">{def.label}</label>
                  <ColorPicker value={val || def.default} onChange={setParam} />
                </div>
              );
            }
            const num = Number(val ?? def.default);
            return (
              <div className="glvr-option-field" key={def.key}>
                <label className="glvr-option-label">{def.label}: {num % 1 === 0 ? num : num.toFixed(2)}</label>
                <input type="range" className="mg-range" min={def.min} max={def.max} step={def.step}
                  value={num} onChange={(e) => setParam(Number(e.target.value))} />
              </div>
            );
          })}
          <div className="glvr-option-field">
            <label className="glvr-option-label">Speed: {(config.shaderSpeed ?? 1).toFixed(1)}×</label>
            <input type="range" className="mg-range" min={0} max={30} step={0.1}
              value={config.shaderSpeed ?? 1} onChange={(e) => update({ shaderSpeed: Number(e.target.value) })} />
          </div>
          <div className="glvr-option-field">
            <label className="glvr-option-label">Scale: {(config.shaderZoom ?? 1).toFixed(2)}×</label>
            <input type="range" className="mg-range" min={0.25} max={4} step={0.05}
              value={config.shaderZoom ?? 1} onChange={(e) => update({ shaderZoom: Number(e.target.value) })} />
          </div>
          <div className="glvr-option-field">
            <label className="glvr-option-label">Detail</label>
            <select
              className="glvr-select"
              value={String(config.shaderScale ?? 1)}
              onChange={(e) => update({ shaderScale: Number(e.target.value) })}
            >
              {SHADER_SCALES.map((s) => <option key={s.value} value={String(s.value)}>{s.label}</option>)}
            </select>
          </div>
          {(config.shaderScale ?? 1) < 1 && (
            <div className="mg-info" style={{ fontSize: 11 }}>
              Rendered at {Math.round((config.shaderScale ?? 1) * 100)}% and scaled up — softer, but shaders that
              measure in pixels (dots, lines, sparkles) stay their intended size instead of shrinking away.
            </div>
          )}
          {/* The shader-source editor lived here and is REMOVED.
              Accepting arbitrary shader code meant compiling user-supplied source
              at runtime, which is the one thing the new renderer cannot do — and
              it forced a validator/sanitiser to exist purely to make that input
              safe. Dropping the input drops all of it. The shipped presets
              remain, and they are what the new renderer draws. */}
        </>
      )}

      {config.type === 'pattern' && (
        <>
          <div className="glvr-option-field">
            <label className="glvr-option-label">Base Color</label>
            <ColorPicker value={config.solidColor || defaultColor} onChange={(v) => update({ solidColor: v })} withAlpha />
          </div>
          <div className="glvr-option-field">
            <label className="glvr-option-label">Pattern Color</label>
            <ColorPicker value={config.patternColor || '#ffffff'} onChange={(v) => update({ patternColor: v })} withAlpha />
          </div>
          <div className="glvr-option-field">
            <label className="glvr-option-label">Choose Pattern</label>
            <div className="mg-grid-4">
              {PATTERN_PRESETS.map((p) => {
                const bg = getPatternBg(p.svg(config.patternColor || '#fff'), config.patternScale || 100, config.solidColor || defaultColor);
                return (
                  <button
                    key={p.id}
                    className={`mg-swatch ${config.patternId === p.id ? 'active' : ''}`}
                    style={{ background: bg }}
                    onClick={() => update({ patternId: p.id })}
                    title={p.name}
                  />
                );
              })}
            </div>
          </div>
          <div className="glvr-option-field">
            <label className="glvr-option-label">Scale: {config.patternScale || 100}%</label>
            <input type="range" className="mg-range" min={10} max={500} step={5} value={config.patternScale || 100} onChange={(e) => update({ patternScale: Number(e.target.value) })} />
          </div>
        </>
      )}

      {config.type === 'transparent' && (
        <div className="mg-info" style={{ marginTop: 8 }}>
          Transparent background exports as WebM with alpha channel.
        </div>
      )}
    </div>
  );
}
