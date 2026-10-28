// The build id, sent to the other phone and written into match.json (`app`, R-PAIR-7).
declare const __APP_BUILD__: string | undefined;

export const APP_BUILD: string = typeof __APP_BUILD__ === 'string' ? __APP_BUILD__ : 'badminton-scoreboard@dev';
