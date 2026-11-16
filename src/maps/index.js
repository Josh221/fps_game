// Map registry: add a new map by writing a module like dustline.js and listing it here.
import dustline from './dustline.js';
import pinewood from './pinewood.js';
import oldtown from './oldtown.js';

export const MAPS = [dustline, pinewood, oldtown];
export const getMap = (id) => MAPS.find((m) => m.id === id) || MAPS[0];
