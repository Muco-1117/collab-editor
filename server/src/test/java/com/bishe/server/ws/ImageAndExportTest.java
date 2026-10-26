package com.bishe.server.ws;

import com.bishe.engine.*;
import com.bishe.server.store.*;
import com.bishe.server.history.HistoryService;
import com.fasterxml.jackson.databind.*;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.test.context.ActiveProfiles;
import javax.imageio.ImageIO;
import java.awt.image.BufferedImage;
import java.io.*;
import java.net.URI;
import java.net.http.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.zip.*;
import static org.junit.jupiter.api.Assertions.*;

@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles("test")
class ImageAndExportTest {
    @LocalServerPort int port;
    @Autowired DocRepo docs;
    @Autowired OpStore store;
    @Autowired RoomRegistry rooms;
    @Autowired HistoryService history;
    final ObjectMapper mapper = new ObjectMapper();
    final HttpClient http = HttpClient.newHttpClient();

    private HttpResponse<byte[]> request(String path, String token, String method, byte[] body, String mime) throws Exception {
        var builder = HttpRequest.newBuilder(URI.create("http://localhost:" + port + path))
                .timeout(java.time.Duration.ofSeconds(15)).method(method,
                        body == null ? HttpRequest.BodyPublishers.noBody() : HttpRequest.BodyPublishers.ofByteArray(body));
        if (token != null) builder.header("Authorization", "Bearer " + token);
        if (mime != null) builder.header("Content-Type", mime);
        return http.send(builder.build(), HttpResponse.BodyHandlers.ofByteArray());
    }
    private HttpResponse<byte[]> json(String path, String token, String method, Map<String, Object> body) throws Exception {
        return request(path, token, method, body == null ? null : mapper.writeValueAsBytes(body), "application/json");
    }
    private static byte[] png() throws Exception {
        BufferedImage image = new BufferedImage(24,16,BufferedImage.TYPE_INT_RGB);
        image.setRGB(4,4,0xff3467);
        ByteArrayOutputStream bytes = new ByteArrayOutputStream(); ImageIO.write(image,"png",bytes); return bytes.toByteArray();
    }
    private HttpResponse<byte[]> upload(String doc, String token, byte[] bytes, String mime) throws Exception {
        String boundary="collab-boundary";
        ByteArrayOutputStream body = new ByteArrayOutputStream();
        body.write(("--"+boundary+"\r\nContent-Disposition: form-data; name=\"file\"; filename=\"sample.png\"\r\nContent-Type: "+mime+"\r\n\r\n").getBytes(StandardCharsets.UTF_8));
        body.write(bytes); body.write(("\r\n--"+boundary+"--\r\n").getBytes(StandardCharsets.UTF_8));
        return request("/api/docs/"+doc+"/images",token,"POST",body.toByteArray(),"multipart/form-data; boundary="+boundary);
    }
    private JsonNode asset(AuthTestSupport.TestDocument document) throws Exception {
        var response=upload(document.docKey(),document.token(),png(),"image/png");
        assertEquals(200,response.statusCode(),new String(response.body(),StandardCharsets.UTF_8));
        JsonNode asset=mapper.readTree(response.body()); assertEquals(24,asset.path("width").asInt()); return asset;
    }
    private CollabRoom room(AuthTestSupport.TestDocument document) {
        var meta=docs.get(document.docKey());
        return rooms.roomFor(document.docKey(),document.kind(),String.valueOf(meta.get("title")),store);
    }
    private Map<String,Object> imageFields(JsonNode asset) {
        return new LinkedHashMap<>(Map.of("assetId",asset.path("assetId").asText(),"url",asset.path("url").asText(),
                "name","示例图片", "mimeType","image/png", "width",24,"height",16,"order",2048));
    }
    @Test void uploadChecksBinaryFormatSizeAndSpaceRoles() throws Exception {
        var owner=AuthTestSupport.document(port,"img-owner","doc");
        var outsider=AuthTestSupport.document(port,"img-other","doc");
        var viewer=AuthTestSupport.document(port,"img-viewer","doc");
        long spaceId=((Number)docs.get(owner.docKey()).get("space_id")).longValue();
        assertEquals(200,json("/api/spaces/"+spaceId+"/members",owner.token(),"POST",Map.of("username",viewer.username(),"role","viewer")).statusCode());
        JsonNode asset=asset(owner);
        String path=asset.path("url").asText();
        assertArrayEquals(png(),request(path,viewer.token(),"GET",null,null).body());
        assertEquals(403,request(path,outsider.token(),"GET",null,null).statusCode());
        assertEquals(401,request(path,null,"GET",null,null).statusCode());
        assertEquals(403,upload(owner.docKey(),viewer.token(),png(),"image/png").statusCode());
        assertEquals(403,upload(owner.docKey(),outsider.token(),png(),"image/png").statusCode());
        assertEquals(400,upload(owner.docKey(),owner.token(),"<svg/>".getBytes(),"image/png").statusCode());
        assertEquals(400,upload(owner.docKey(),owner.token(),png(),"image/jpeg").statusCode());
        assertEquals(413,upload(owner.docKey(),owner.token(),new byte[9*1024*1024],"image/png").statusCode());
    }
    @Test void stateImageSurvivesWebSocketDedupeReplaySnapshotRestartAndRestore() throws Exception {
        var doc=AuthTestSupport.document(port,"img-state","doc");
        JsonNode asset=asset(doc);
        var client=new CollabWsIntegrationTest.TestClient(); client.tokenParam=doc.token();
        client.connect(URI.create("ws://localhost:"+port+"/ws/collab"));
        client.send(mapper.writeValueAsString(Map.of("type","hello","docId",doc.docKey(),"clientId","image-client","lastRev",0)));
        client.nextOfType("welcome",5);
        Op op=Op.state("image-one",ElementType.IMAGE,imageFields(asset),"image-op",new LamportClock("image-client",100));
        String frame=mapper.writeValueAsString(Map.of("type","op","op",CollabMessage.opToJson(op)));
        client.send(frame); long revision=client.nextOfType("applied",5).path("rev").asLong();
        client.send(frame); assertTrue(client.nextOfType("applied",5).path("duplicate").asBoolean());
        var otherDoc=AuthTestSupport.document(port,"foreign-image","board");
        JsonNode foreign=asset(otherDoc);
        Op invalid=Op.state("foreign",ElementType.IMAGE,imageFields(foreign),"foreign-op",new LamportClock("image-client",101));
        client.send(mapper.writeValueAsString(Map.of("type","op","op",CollabMessage.opToJson(invalid))));
        assertEquals("INVALID_IMAGE",client.nextOfType("error",5).path("code").asText());
        client.close();
        assertEquals(revision,store.maxSeq(doc.docKey()));
        CollabRoom room=room(doc);
        store.saveSnapshot(doc.docKey(),revision,OpStore.encodeElements(new ArrayList<>(room.state().elements().values())));
        CollabRoom rebuilt=new CollabRoom(doc.docKey(),"doc","自动化测试",store);
        assertEquals(room.state().canonicalHash(),rebuilt.state().canonicalHash());
        Map<String,Object> retryFields=imageFields(asset); retryFields.put("width",24L); retryFields.put("height",16L); retryFields.put("order",2048L);
        var retry=Op.state("image-one",ElementType.IMAGE,retryFields,"image-op",new LamportClock("image-client",100));
        var retrySocket = org.mockito.Mockito.mock(org.springframework.web.socket.WebSocketSession.class);
        org.mockito.Mockito.when(retrySocket.isOpen()).thenReturn(true);
        var retrySession = new CollabSession("image-client","test",retrySocket,1,"test","editor");
        rebuilt.joinAndSync(retrySession, 0);
        try {
            assertEquals(CollabRoom.ApplyStatus.DUPLICATE,
                    rebuilt.applyClientOp(retry,"image-op",retrySession).status());
        } finally {
            rebuilt.leave(retrySession);
            retrySession.forceClose();
        }
        assertTrue(history.replay(doc.docKey(),revision).toString().contains(asset.path("assetId").asText()));
        Map<String,Object> deleted=imageFields(asset); deleted.put(Element.TOMBSTONE_KEY,true);
        room.applyExternal(List.of(Op.state("image-one",ElementType.IMAGE,deleted,"delete-image",new LamportClock("restore-test",101))));
        assertTrue(room.state().element("image-one").isTombstone());
        room.applyExternal(history.restoreOps(doc.docKey(),revision));
        assertFalse(room.state().element("image-one").isTombstone());
        assertEquals(asset.path("assetId").asText(),room.state().element("image-one").fields().get("assetId").value());
    }
    @Test void everyAdvertisedFormatContainsTextImageOrAttachmentMetadata() throws Exception {
        for(String kind:List.of("doc","board","kanban")) {
            var document=AuthTestSupport.document(port,"exports-"+kind,kind);
            JsonNode image=asset(document); CollabRoom room=room(document);
            List<Op> ops=new ArrayList<>();
            if("kanban".equals(kind)) {
                ops.add(Op.state("list",ElementType.COLUMN,Map.of("title","待处理","order",1),"list-op",new LamportClock("export",100)));
                ops.add(Op.state("task",ElementType.CARD,Map.of("column","list","text","测试任务","order",1,"coverId",image.path("assetId").asText(),"coverUrl",image.path("url").asText(),"coverName","示例图片"),"task-op",new LamportClock("export",101)));
            } else {
                ops.add(Op.state("text-one","doc".equals(kind)?ElementType.TEXT:ElementType.CARD,Map.of("text","中文内容<&>\n第二行","order",1,"x",40,"y",40),"text-op",new LamportClock("export",100)));
                var fields=imageFields(image); fields.put("x",300);fields.put("y",40);
                ops.add(Op.state("image-one",ElementType.IMAGE,fields,"img-op",new LamportClock("export",101)));
            }
            room.applyExternal(ops);
            List<String> formats=switch(kind) {case "board" -> List.of("svg","png","md");case "kanban" -> List.of("csv","xlsx","md");default -> List.of("docx","html","txt","md");};
            for(String format:formats) {
                var response=request("/api/docs/"+document.docKey()+"/export?format="+format,document.token(),"GET",null,null);
                assertEquals(200,response.statusCode(),format+": "+new String(response.body(),StandardCharsets.UTF_8));
                String text=new String(response.body(),StandardCharsets.UTF_8);
                switch(format) {
                    case "docx" -> {
                        var files=unzip(response.body()); assertTrue(files.containsKey("word/media/image1.png"));
                        assertTrue(new String(files.get("word/document.xml"),StandardCharsets.UTF_8).contains("中文内容&lt;&amp;&gt;"));
                        assertNotNull(ImageIO.read(new ByteArrayInputStream(files.get("word/media/image1.png"))));
                    }
                    case "xlsx" -> {
                        String sheet=new String(unzip(response.body()).get("xl/worksheets/sheet1.xml"),StandardCharsets.UTF_8);
                        assertTrue(sheet.contains("待处理")); assertTrue(sheet.contains("测试任务")); assertTrue(sheet.contains(image.path("assetId").asText()));
                    }
                    case "png" -> assertNotNull(ImageIO.read(new ByteArrayInputStream(response.body())));
                    case "svg","html" -> { assertTrue(text.contains("data:image/png;base64,")); assertTrue(text.contains("中文内容")); }
                    case "csv" -> {assertTrue(text.contains("测试任务"));assertTrue(text.contains("待处理"));assertTrue(text.contains(image.path("assetId").asText()));}
                    case "md" -> assertTrue(text.contains("data:image/png;base64,"));
                    case "txt" -> {assertTrue(text.contains("中文内容"));assertTrue(text.contains("示例图片"));}
                }
            }
            assertEquals(400,request("/api/docs/"+document.docKey()+"/export?format=unknown",document.token(),"GET",null,null).statusCode());
        }
    }
    private static Map<String,byte[]> unzip(byte[] bytes) throws Exception {
        Map<String,byte[]> out=new HashMap<>();
        try(ZipInputStream zip=new ZipInputStream(new ByteArrayInputStream(bytes))) { for(ZipEntry entry;(entry=zip.getNextEntry())!=null;) out.put(entry.getName(),zip.readAllBytes()); }
        return out;
    }
}
