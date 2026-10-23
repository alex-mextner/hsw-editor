/** Side-effect module: mounts the DOM globals. Imported by dom.tsx ahead of react-dom (import order = eval order). */
import { installDomGlobals } from './domGlobals.ts';

installDomGlobals();
