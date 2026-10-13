package controlstudio;

public final class ControlStudioSmoke {
  public static void main(String[] args) throws Exception {
    var client=new ControlStudioClient(args[0],"sdk-fixture-token","development");
    String resolved=client.resolve("sdk-support","{\"context\":{\"userId\":\"java-subject\"},\"variables\":{}}");
    if(!resolved.contains("\"model\":\"fixture\""))throw new AssertionError("Missing resolved configuration");
    var matcher=java.util.regex.Pattern.compile("\"traceId\":\"([^\"]+)\"").matcher(resolved);
    if(!matcher.find())throw new AssertionError("Missing trace identifier");
    String outcome=client.outcome("{\"traceId\":\""+matcher.group(1)+"\",\"metrics\":{\"success\":true,\"quality\":1}}");
    if(!outcome.contains("\"success\":true"))throw new AssertionError("Outcome not recorded");
    try{new ControlStudioClient(args[0],"bad-token","development").resolve("sdk-support","{}");throw new AssertionError("Invalid token accepted");}
    catch(ControlStudioClient.ApiException error){if(error.status!=401)throw error;}
    System.out.println("Java SDK HTTP resolve, outcome and authorization passed.");
  }
}
