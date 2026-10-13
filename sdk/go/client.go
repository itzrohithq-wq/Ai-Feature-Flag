// Package runtime retrieves runtime configuration; application callbacks own model execution.
package runtime

import (
 "bufio"
 "bytes"
 "context"
 "encoding/json"
 "fmt"
 "io"
 "net/http"
 "net/url"
 "strings"
 "time"
)

type Client struct { BaseURL, Token, Environment string; HTTP *http.Client }
type APIError struct { Status int; Code, Message string }
func (e *APIError) Error() string { return fmt.Sprintf("runtime %d %s: %s",e.Status,e.Code,e.Message) }
type Resolved struct { TraceID string `json:"traceId"`; Variation string `json:"variation"`; Version int `json:"version"`; Configuration map[string]any `json:"configuration"`; Mode string `json:"mode"`; Sampled bool `json:"sampled"`; Judge map[string]any `json:"judge"`; Judges []map[string]any `json:"judges"`; Retry map[string]any `json:"retry"` }
type Completion struct { Output string; Metrics map[string]any }
type Execution struct { Resolved Resolved; Output string; Telemetry map[string]any; ExecutionError, TelemetryError error }
type Executor func(context.Context, Resolved, string) (Completion,error)
type Evaluator func(context.Context, map[string]any, string, string, string) (map[string]any,error)

func New(baseURL,token,environment string) *Client { return &Client{strings.TrimRight(baseURL,"/"),token,environment,&http.Client{Timeout:10*time.Second}} }
func (c *Client) Request(ctx context.Context,path,method string,body any,result any) error {
 var payload []byte; var err error
 if body!=nil { payload,err=json.Marshal(body);if err!=nil{return err} }
 req,err:=http.NewRequestWithContext(ctx,method,c.BaseURL+"/api/runtime/"+path+"?environment="+url.QueryEscape(c.Environment),bytes.NewReader(payload));if err!=nil{return err}
 req.Header.Set("Authorization","Bearer "+c.Token);if body!=nil{req.Header.Set("Content-Type","application/json")}
 response,err:=c.HTTP.Do(req);if err!=nil{return err};defer response.Body.Close()
 reader:=io.LimitReader(response.Body,8<<20)
 if response.StatusCode>=400 {var envelope struct{ Error struct { Code,Message string } };_ = json.NewDecoder(reader).Decode(&envelope);return &APIError{response.StatusCode,envelope.Error.Code,envelope.Error.Message}}
 if result==nil {_,err=io.Copy(io.Discard,reader);return err};return json.NewDecoder(reader).Decode(result)
}
func (c *Client) Resolve(ctx context.Context,key string,subject,variables map[string]any) (Resolved,error) {var r Resolved;err:=c.Request(ctx,"configs/"+url.PathEscape(key)+"/resolve","POST",map[string]any{"context":subject,"variables":variables},&r);return r,err}
func (c *Client) Outcome(ctx context.Context,trace string,metrics map[string]any) (map[string]any,error) {var r map[string]any;err:=c.Request(ctx,"outcomes","POST",map[string]any{"traceId":trace,"metrics":metrics},&r);return r,err}
func (c *Client) Execute(ctx context.Context,key string,subject,variables map[string]any,input,expected string,executor Executor,evaluator Evaluator) (Execution,error) {
 resolved,err:=c.Resolve(ctx,key,subject,variables);if err!=nil{return Execution{},err}
 result:=Execution{Resolved:resolved};started:=time.Now();completion,executionErr:=executor(ctx,resolved,input);result.Output=completion.Output;result.ExecutionError=executionErr
 metrics:=map[string]any{};for k,v:=range completion.Metrics{metrics[k]=v};metrics["success"]=executionErr==nil;metrics["latencyMs"]=float64(time.Since(started).Microseconds())/1000
 event:=map[string]any{"traceId":resolved.TraceID,"metrics":metrics}
 if resolved.Sampled&&executionErr==nil { judges:=resolved.Judges;if len(judges)==0&&resolved.Judge!=nil{judges=[]map[string]any{resolved.Judge}};judgments:=map[string]any{}
  for _,judge:=range judges{if judge["type"]=="llm" {if evaluator==nil{return result,fmt.Errorf("LLM judge requires evaluator callback")};score,err:=evaluator(ctx,judge,input,completion.Output,expected);if err!=nil{return result,err};key,_:=judge["key"].(string);judgments[key]=score}}
  if len(judges)>0{event["input"]=input;event["output"]=completion.Output;event["expected"]=expected;event["judgements"]=judgments;if resolved.Judge!=nil&&resolved.Judge["type"]=="llm"{event["judgement"]=judgments[resolved.Judge["key"].(string)]}}
 }
 result.TelemetryError=c.Request(ctx,"outcomes","POST",event,&result.Telemetry);return result,nil
}
func (c *Client) EnqueueEvaluation(ctx context.Context,config,dataset,judge string,allowCharges bool) (map[string]any,error) {var result map[string]any;err:=c.Request(ctx,"jobs","POST",map[string]any{"config":config,"dataset":dataset,"judge":judge,"allowProviderCalls":allowCharges},&result);return result,err}
// Watch uses the caller's context as the stream deadline; cancellation closes the body.
func (c *Client) Watch(ctx context.Context,key string,onConfig func(json.RawMessage) error) error {
 req,err:=http.NewRequestWithContext(ctx,"GET",c.BaseURL+"/api/runtime/configs/"+url.PathEscape(key)+"/watch?environment="+url.QueryEscape(c.Environment),nil);if err!=nil{return err};req.Header.Set("Authorization","Bearer "+c.Token)
 streamClient:=&http.Client{Transport:c.HTTP.Transport};response,err:=streamClient.Do(req);if err!=nil{return err};defer response.Body.Close();if response.StatusCode!=200{return &APIError{Status:response.StatusCode,Message:"Configuration stream denied"}}
 scanner:=bufio.NewScanner(response.Body);scanner.Buffer(make([]byte,4096),2<<20);for scanner.Scan(){line:=scanner.Text();if strings.HasPrefix(line,"data: "){payload:=json.RawMessage(strings.TrimPrefix(line,"data: "));if !json.Valid(payload){return fmt.Errorf("Invalid configuration event")};if err:=onConfig(payload);err!=nil{return err}}};return scanner.Err()
}
