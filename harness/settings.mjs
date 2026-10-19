import {readFileSync} from 'node:fs';
export const settings=Object.freeze(JSON.parse(readFileSync(new URL('./production-settings.json',import.meta.url),'utf8')));
if(typeof settings.retainPassHistory!=='boolean'||(settings.diagnosticReason!==null&&(typeof settings.diagnosticReason!=='string'||!settings.diagnosticReason.trim()||settings.diagnosticReason.length>120)))throw new Error('INVALID_DATA_COLLECTION_SETTINGS');
if(!Number.isInteger(settings.cycleSeconds)||settings.cycleSeconds<1||settings.cycleSeconds>3600||!Number.isInteger(settings.resourceObservationMaxAgeMs)||settings.resourceObservationMaxAgeMs<0||settings.resourceObservationMaxAgeMs>15000||!Number.isInteger(settings.recoveryBackoffSeconds)||settings.recoveryBackoffSeconds<10)throw new Error('INVALID_PRODUCTION_SETTINGS');
