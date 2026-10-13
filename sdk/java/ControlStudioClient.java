package controlstudio;

import java.io.IOException;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.function.Consumer;

/** Java 17+ JSON transport. Use your application's JSON codec for domain objects. */
public final class ControlStudioClient {
  private final String baseUrl, token, environment;
  private final HttpClient http;
  public static final class ApiException extends IOException {
    public final int status;
    public final String response;
    ApiException(int status,String response){super("Runtime request failed ("+status+")");this.status=status;this.response=response;}
  }
  public ControlStudioClient(String baseUrl,String token,String environment){
    this.baseUrl=baseUrl.replaceAll("/$","");this.token=token;this.environment=environment;
    this.http=HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).followRedirects(HttpClient.Redirect.NEVER).build();
  }
  private static String encode(String value){return URLEncoder.encode(value,StandardCharsets.UTF_8).replace("+","%20");}
  private HttpRequest.Builder requestBuilder(String path){return HttpRequest.newBuilder(URI.create(baseUrl+"/api/runtime/"+path+"?environment="+encode(environment))).header("Authorization","Bearer "+token);}
  public String request(String path,String method,String json) throws IOException,InterruptedException {
    HttpRequest.Builder builder=requestBuilder(path).timeout(Duration.ofSeconds(10));
    if(json!=null)builder.header("Content-Type","application/json");
    HttpResponse<String> response=http.send(builder.method(method,json==null?HttpRequest.BodyPublishers.noBody():HttpRequest.BodyPublishers.ofString(json)).build(),HttpResponse.BodyHandlers.ofString());
    if(response.statusCode()>=400)throw new ApiException(response.statusCode(),response.body());
    return response.body();
  }
  public String resolve(String key,String contextAndVariablesJson) throws IOException,InterruptedException{return request("configs/"+encode(key)+"/resolve","POST",contextAndVariablesJson);}
  public String outcome(String eventJson) throws IOException,InterruptedException{return request("outcomes","POST",eventJson);}
  public String enqueueEvaluation(String jobJson) throws IOException,InterruptedException{return request("jobs","POST",jobJson);}
  public String job(String id) throws IOException,InterruptedException{return request("jobs/"+encode(id),"GET",null);}
  public String graph(String key,String contextAndVariablesJson) throws IOException,InterruptedException{return request("graphs/"+encode(key)+"/resolve","POST",contextAndVariablesJson);}
  public String visitGraphNode(String key,String visitJson) throws IOException,InterruptedException{return request("graphs/"+encode(key)+"/visit","POST",visitJson);}
  public String ingestSpans(String otlpJson) throws IOException,InterruptedException{return request("traces","POST",otlpJson);}
  public void watch(String key,Consumer<String> onConfiguration) throws IOException,InterruptedException {
    HttpResponse<java.util.stream.Stream<String>> response=http.send(requestBuilder("configs/"+encode(key)+"/watch").GET().build(),HttpResponse.BodyHandlers.ofLines());
    try(var lines=response.body()){
      if(response.statusCode()!=200)throw new ApiException(response.statusCode(),"Configuration stream denied");
      var iterator=lines.iterator();while(!Thread.currentThread().isInterrupted()&&iterator.hasNext()){String line=iterator.next();if(line.startsWith("data: "))onConfiguration.accept(line.substring(6));}
    }
  }
}
