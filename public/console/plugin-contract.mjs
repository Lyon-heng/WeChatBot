// Node-based UI tests use this adapter; the HTTP route serves the same contract.
export {PERMISSION_LABELS,FEATURE_LABELS} from '../../packages/plugin-api/contract.mjs';
import {BUNDLED_PLUGINS} from '../../packages/plugin-api/bundled.mjs';
export const BUILTIN_PLUGIN_PACKAGES=Object.freeze(BUNDLED_PLUGINS.filter(item=>item.zip).map(({id,name,version})=>Object.freeze({id,name,version})));
