export class ProviderUsage {
  constructor(){this.input=0;this.output=0;this.knownInput=true;this.knownOutput=true;}
  add(input,output){
    for(const [name,value] of [['input',input],['output',output]]){
      if(value===undefined||value===null){this[name==='input'?'knownInput':'knownOutput']=false;continue;}
      if(!Number.isSafeInteger(value)||value<0||!Number.isSafeInteger(this[name]+value))throw new Error('Provider returned invalid token usage.');
      this[name]+=value;
    }
  }
  metrics(pricing){
    const result={...(this.knownInput?{inputTokens:this.input}:{}),...(this.knownOutput?{outputTokens:this.output}:{})};
    if(pricing&&this.knownInput&&this.knownOutput)result.costUsd=(this.input*pricing.inputPerMillion+this.output*pricing.outputPerMillion)/1e6;
    return result;
  }
}
