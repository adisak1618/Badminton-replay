// The one live match of this scoreboard phone.
import { saveMatch } from './persist';
import { deviceId } from './prefs';
import { MatchStore } from './store';

export const store = new MatchStore(saveMatch, deviceId);
