// Bounded, time-uniform Hoeffding intervals. Alpha spending covers repeated looks
// and all arms; these are deliberately conservative, not vendor-equivalent tests.
export function interval(values, {alpha=.05, arms=1, sequential=true}={}) {
  if(!values.length)return {samples:0,mean:null,lower:null,upper:null};
  const n=values.length, mean=values.reduce((a,b)=>a+b,0)/n;
  const budget=alpha/arms/(sequential?n*(n+1):1);
  const radius=Math.sqrt(Math.log(2/budget)/(2*n));
  return {samples:n,mean,lower:Math.max(0,mean-radius),upper:Math.min(1,mean+radius)};
}
export function experimentAnalysis(config, records, exposures=[]) {
  const metric=config.experiment?.metric ?? 'reward',alpha=config.experiment?.alpha ?? .05;
  const baseline=config.experiment?.baseline ?? config.defaultVariation;
  // One observation per subject prevents repeat requests from becoming fake samples.
  const subjects=new Map();
  for(const row of records) {
    if(['holdout','targeted','explicit','retry'].includes(row.reason))continue;
    const subject=row.subject ?? row.id;
    const value=metric==='errorRate'?Number(!row.metrics.success):row.metrics[metric];
    if(Number.isFinite(value)&&value>=0&&value<=1&&!subjects.has(subject))subjects.set(subject,{variation:row.variation,value});
  }
  const arms=config.variations.filter(v=>v.weight>0).map(v=>({variation:v.id,...interval([...subjects.values()].filter(r=>r.variation===v.id).map(r=>r.value),{alpha,arms:config.variations.length})}));
  const control=arms.find(a=>a.variation===baseline);
  const comparisons=arms.filter(a=>a.variation!==baseline).map(a=>({variation:a.variation,lower:control?.samples&&a.samples?a.lower-control.upper:null,upper:control?.samples&&a.samples?a.upper-control.lower:null}));
  const seen=new Map();for(const row of exposures)if(row.subject&&!['holdout','targeted','explicit','retry'].includes(row.reason)&&!seen.has(row.subject))seen.set(row.subject,row.variation);
  const total=seen.size;
  const allocation=config.variations.filter(v=>v.weight>0).map(v=>{const observed=[...seen.values()].filter(id=>id===v.id).length;const expected=v.weight/100;const radius=total?Math.sqrt(Math.log(2*config.variations.length*total*(total+1)/.001)/(2*total)):1;return {variation:v.id,observed,expectedShare:expected,mismatch:total>=100&&Math.abs(observed/total-expected)>radius};});
  const srm=config.experiment?.mode==='bandit'?{applicable:false,reason:'Adaptive allocation is not fixed-weight randomization.'}:{applicable:true,samples:total,detected:allocation.some(a=>a.mismatch),allocation};
  const minimum=config.experiment?.minSamples ?? 30;
  const winner=config.experiment?.mode==='bandit'||srm.detected||!arms.every(a=>a.samples>=minimum)?null:arms.find(a=>a.variation!==baseline&&arms.every(other=>other===a||(metric==='errorRate'?a.upper<other.lower:a.lower>other.upper)))?.variation??null;
  return {method:'time-uniform bounded Hoeffding intervals',metric,alpha,baseline,arms,comparisons,sampleRatio:srm,winner,status:winner?'winner':srm.detected?'allocation-mismatch':'inconclusive'};
}
export function sampleSize({effect=.05,alpha=.05,arms=2}={}) {
  if(!Number.isFinite(effect)||effect<=0||effect>1||!Number.isFinite(alpha)||alpha<=0||alpha>=1||!Number.isInteger(arms)||arms<2||arms>20)throw Object.assign(new Error('Use effect (0,1], alpha (0,1), and 2–20 arms.'),{status:400,code:'INVALID_ANALYSIS'});
  return {perArm:Math.ceil(2*Math.log(2*arms/alpha)/(effect*effect)),effect,alpha,method:'Conservative bounded-mean precision planning; not a power guarantee.'};
}

