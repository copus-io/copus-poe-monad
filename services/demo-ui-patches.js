const { validateCampaignSchedule } = require('./campaign-schedule');

// The repositories ship compiled Copus UI rather than frontend source. Adapt
// the known editor/card hooks at serve time; the checksummed archive is unchanged.
// Both the modern and legacy bundles use these hooks. Fail on an unexpected
// layout instead of silently shipping partially applied validation.
function patchDemoUi(source) {
  if (!source.includes('name:"endsAt",label:')) return source;
  const replaceOnce = (needle, replacement) => {
    const parts = source.split(needle);
    if (parts.length !== 2) throw new Error('Bundled Copus UI schedule hook changed');
    source = parts.join(replacement);
  };
  const validate = `(${validateCampaignSchedule.toString()})`;
  replaceOnce('name:"startsAt",label:', `name:"startsAt",rules:[{validator:(_,value)=>{try{${validate}({startsAt:value,unlimited:true});return Promise.resolve()}catch(error){return Promise.reject(error)}}}],label:`);
  replaceOnce('name:"endsAt",label:', `name:"endsAt",dependencies:["startsAt","unlimited"],rules:[({getFieldValue})=>({validator:(_,value)=>{try{${validate}({startsAt:getFieldValue("startsAt"),endsAt:value,unlimited:getFieldValue("unlimited")});return Promise.resolve()}catch(error){return Promise.reject(error)}}})],label:`);
  const matches = [...source.matchAll(/children:(\w+)\.eligible\?\w+\("clientUI\.time\.sponsors\.claimAmount",\{amount:\w+\(\w+\.claimSeconds,(\w+)\.language\)\}\)/g)];
  if (matches.length !== 1) throw new Error('Bundled Copus UI claim label hook changed');
  const [match, sponsor, i18n] = matches[0];
  source = source.replace(match, `children:${sponsor}.poeScheduleStatus==="SCHEDULED"?(${i18n}.language.startsWith("zh")?"尚未开始":"Starts soon"):${sponsor}.poeScheduleStatus==="ENDED"?(${i18n}.language.startsWith("zh")?"活动已结束":"Campaign ended"):${match.slice('children:'.length)}`);
  return source;
}
module.exports = { patchDemoUi };
