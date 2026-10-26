package com.bishe.server.web;

import com.bishe.server.store.ImageAssetRepo;
import com.fasterxml.jackson.databind.JsonNode;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import javax.imageio.ImageIO;
import java.awt.*;
import java.awt.image.BufferedImage;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.List;
import java.util.*;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;

/** 按应用类型导出；从同一已提交快照生成内容，图片内嵌且不下载外部 URL。 */
@Service
public class ContentExportService {
    public record Export(byte[] bytes, String mime, String extension) {}
    private final ImageAssetRepo assets;
    private final Path uploadRoot;
    public ContentExportService(ImageAssetRepo assets, @Value("${app.upload-dir:./data/uploads}") String directory) {
        this.assets = assets;
        this.uploadRoot = Path.of(directory).toAbsolutePath().normalize();
    }
    public Export generate(String docId, String title, String kind, String format, JsonNode snapshot) {
        List<JsonNode> elements = new ArrayList<>();
        snapshot.forEach(el -> { if (!el.path("fields").path("#tombstone").path("value").asBoolean(false)) elements.add(el); });
        elements.sort(Comparator.comparingDouble((JsonNode el) -> number(el, "order", 0)).thenComparing(el -> el.path("id").asText()));
        Set<String> supported = switch (kind) {
            case "board" -> Set.of("svg", "png", "md");
            case "kanban" -> Set.of("csv", "xlsx", "md");
            default -> Set.of("md", "html", "txt", "docx");
        };
        if (!supported.contains(format)) throw new IllegalArgumentException("该内容类型不支持此导出格式");
        try {
            return switch (format) {
                case "svg" -> text(boardSvg(docId, title, elements), "image/svg+xml", "svg");
                case "png" -> new Export(boardPng(docId, title, elements), "image/png", "png");
                case "csv" -> text("\uFEFF" + csv(title, elements), "text/csv; charset=UTF-8", "csv");
                case "xlsx" -> new Export(xlsx(title, elements), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "xlsx");
                case "docx" -> new Export(docx(docId, title, elements), "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "docx");
                case "html" -> text(html(docId, title, elements), "text/html; charset=UTF-8", "html");
                case "txt" -> text(plain(title, elements), "text/plain; charset=UTF-8", "txt");
                default -> text(markdown(docId, title, kind, elements), "text/markdown; charset=UTF-8", "md");
            };
        } catch (IOException e) { throw new IllegalStateException("导出资源读取失败", e); }
    }
    private static Export text(String text, String mime, String extension) { return new Export(text.getBytes(StandardCharsets.UTF_8), mime, extension); }
    static String value(JsonNode el, String name) { return el.path("fields").path(name).path("value").asText(""); }
    static double number(JsonNode el, String name, double fallback) {
        double n = el.path("fields").path(name).path("value").asDouble(fallback);
        return Double.isFinite(n) ? n : fallback;
    }
    static String xml(String text) { return text.replaceAll("[\\x00-\\x08\\x0B\\x0C\\x0E-\\x1F]", "").replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace("\"", "&quot;").replace("'", "&apos;"); }
    private byte[] image(String docId, String assetId) throws IOException {
        ImageAssetRepo.Asset asset = assets.find(assetId);
        if (asset == null || !docId.equals(asset.docId())) throw new IOException("图片不属于当前内容或已缺失");
        Path path = Path.of(asset.storagePath()).toAbsolutePath().normalize();
        if (!path.startsWith(uploadRoot) || !Files.isRegularFile(path)) throw new IOException("图片文件缺失");
        return Files.readAllBytes(path);
    }
    private String dataUri(String docId, String id) throws IOException {
        ImageAssetRepo.Asset asset = assets.find(id);
        if (asset == null) throw new IOException("图片元数据缺失");
        return "data:" + asset.mimeType() + ";base64," + Base64.getEncoder().encodeToString(image(docId, id));
    }
    private static boolean is(JsonNode el, String type) { return type.equals(el.path("type").asText()); }
    private static boolean documentItem(JsonNode el) { return is(el, "TEXT") || is(el, "IMAGE") || (is(el, "DOC") && !value(el, "text").isBlank()); }
    private String markdown(String docId, String title, String kind, List<JsonNode> els) throws IOException {
        StringBuilder out = new StringBuilder("# " + title + "\n\n");
        if ("kanban".equals(kind)) {
            for (List<String> row : rows(title, els)) out.append(String.join(" | ", row)).append("\n\n");
            for (JsonNode el : els) if (!value(el, "coverId").isBlank()) out.append("![").append(value(el, "coverName").replace("]", "\\]")).append("](").append(dataUri(docId, value(el, "coverId"))).append(")\n\n");
        } else for (JsonNode el : els) {
            if (is(el, "IMAGE")) out.append("![").append(value(el, "name").replace("]", "\\]")).append("](").append(dataUri(docId, value(el, "assetId"))).append(")\n\n");
            else if (documentItem(el) || is(el, "CARD")) out.append(value(el, "text")).append("\n\n");
        }
        return out.toString();
    }
    private String html(String docId, String title, List<JsonNode> els) throws IOException {
        StringBuilder out = new StringBuilder("<!doctype html><html lang=\"zh-CN\"><meta charset=\"utf-8\"><title>" + xml(title) + "</title><style>body{font:16px/1.8 sans-serif;max-width:850px;margin:48px auto;padding:20px}img{max-width:100%;height:auto}p{white-space:pre-wrap}figure{margin:24px 0}</style><body><h1>" + xml(title) + "</h1>");
        for (JsonNode el : els) {
            if (is(el, "IMAGE")) out.append("<figure><img alt=\"").append(xml(value(el, "name"))).append("\" src=\"").append(dataUri(docId, value(el, "assetId"))).append("\"><figcaption>").append(xml(value(el, "name"))).append("</figcaption></figure>");
            else if (documentItem(el)) out.append("<p>").append(xml(value(el, "text"))).append("</p>");
        }
        return out.append("</body></html>").toString();
    }
    private String plain(String title, List<JsonNode> els) {
        StringBuilder out = new StringBuilder(title + "\n\n");
        for (JsonNode el : els) if (documentItem(el)) out.append(is(el, "IMAGE") ? "[图片] " + value(el, "name") + " " + value(el, "url") : value(el, "text")).append("\n\n");
        return out.toString();
    }
    private static List<List<String>> rows(String title, List<JsonNode> els) {
        List<List<String>> out = new ArrayList<>();
        out.add(List.of("看板", "列表", "任务ID", "任务内容", "排序", "封面名称", "封面引用", "封面ID"));
        Map<String, String> columns = new LinkedHashMap<>();
        for (JsonNode el : els) if (is(el, "COLUMN")) columns.put(el.path("id").asText(), value(el, "title"));
        for (var column : columns.entrySet()) {
            List<JsonNode> cards = els.stream().filter(el -> is(el, "CARD") && column.getKey().equals(value(el, "column"))).toList();
            if (cards.isEmpty()) out.add(List.of(title, column.getValue(), "", "", "", "", "", ""));
            for (JsonNode card : cards) out.add(row(title, column.getValue(), card));
        }
        for (JsonNode card : els) if (is(card, "CARD") && !columns.containsKey(value(card, "column"))) out.add(row(title, "未分配", card));
        return out;
    }
    private static List<String> row(String title, String column, JsonNode card) {
        return List.of(title, column, card.path("id").asText(), value(card, "text"), value(card, "order"), value(card, "coverName"), value(card, "coverUrl"), value(card, "coverId"));
    }
    private static String csv(String title, List<JsonNode> els) {
        StringBuilder out = new StringBuilder();
        for (List<String> row : rows(title, els)) {
            out.append(row.stream().map(cell -> "\"" + safeCell(cell).replace("\"", "\"\"") + "\"").collect(java.util.stream.Collectors.joining(","))).append("\r\n");
        }
        return out.toString();
    }
    private static String safeCell(String cell) {
        String content = cell.stripLeading();
        return !content.isEmpty() && "=+@-".indexOf(content.charAt(0)) >= 0 ? "'" + cell : cell;
    }
    private static byte[] xlsx(String title, List<JsonNode> els) throws IOException {
        Map<String, byte[]> files = new LinkedHashMap<>();
        files.put("[Content_Types].xml", utf("<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"><Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/><Default Extension=\"xml\" ContentType=\"application/xml\"/><Override PartName=\"/xl/workbook.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml\"/><Override PartName=\"/xl/worksheets/sheet1.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml\"/></Types>"));
        files.put("_rels/.rels", utf(relationships("xl/workbook.xml", "officeDocument")));
        files.put("xl/workbook.xml", utf("<workbook xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\" xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\"><sheets><sheet name=\"协同看板\" sheetId=\"1\" r:id=\"rId1\"/></sheets></workbook>"));
        files.put("xl/_rels/workbook.xml.rels", utf(relationships("worksheets/sheet1.xml", "worksheet")));
        StringBuilder sheet = new StringBuilder("<worksheet xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\"><cols><col min=\"1\" max=\"8\" width=\"28\" customWidth=\"1\"/></cols><sheetData>");
        int n = 1;
        for (List<String> row : rows(title, els)) {
            sheet.append("<row r=\"").append(n).append("\">");
            for (int c = 0; c < row.size(); c++) sheet.append("<c r=\"").append((char)('A' + c)).append(n).append("\" t=\"inlineStr\"><is><t xml:space=\"preserve\">").append(xml(row.get(c))).append("</t></is></c>");
            sheet.append("</row>"); n++;
        }
        files.put("xl/worksheets/sheet1.xml", utf(sheet.append("</sheetData></worksheet>").toString()));
        return zip(files);
    }
    private static String relationships(String target, String type) { return "<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/" + type + "\" Target=\"" + target + "\"/></Relationships>"; }
    private byte[] docx(String docId, String title, List<JsonNode> els) throws IOException {
        Map<String, byte[]> files = new LinkedHashMap<>();
        StringBuilder types = new StringBuilder("<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"><Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/><Default Extension=\"xml\" ContentType=\"application/xml\"/><Default Extension=\"png\" ContentType=\"image/png\"/><Override PartName=\"/word/document.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml\"/></Types>");
        files.put("[Content_Types].xml", utf(types.toString()));
        files.put("_rels/.rels", utf(relationships("word/document.xml", "officeDocument")));
        StringBuilder body = new StringBuilder("<w:document xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\" xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\" xmlns:wp=\"http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing\" xmlns:a=\"http://schemas.openxmlformats.org/drawingml/2006/main\" xmlns:pic=\"http://schemas.openxmlformats.org/drawingml/2006/picture\"><w:body>");
        body.append(paragraph(title, true));
        StringBuilder rels = new StringBuilder("<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">");
        int id = 1;
        for (JsonNode el : els) {
            if (is(el, "IMAGE")) {
                BufferedImage bitmap = ImageIO.read(new ByteArrayInputStream(image(docId, value(el, "assetId"))));
                if (bitmap == null) throw new IOException("图片无法解码");
                ByteArrayOutputStream png = new ByteArrayOutputStream(); ImageIO.write(bitmap, "png", png);
                files.put("word/media/image" + id + ".png", png.toByteArray());
                rels.append("<Relationship Id=\"img").append(id).append("\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/image\" Target=\"media/image").append(id).append(".png\"/>");
                double scale = Math.min(1.0, Math.min(550.0 / bitmap.getWidth(), 650.0 / bitmap.getHeight()));
                long cx = Math.max(1, Math.round(bitmap.getWidth() * scale * 9525));
                long cy = Math.max(1, Math.round(bitmap.getHeight() * scale * 9525));
                body.append("<w:p><w:r><w:drawing><wp:inline><wp:extent cx=\"").append(cx).append("\" cy=\"").append(cy).append("\"/><wp:docPr id=\"").append(id).append("\" name=\"").append(xml(value(el, "name"))).append("\"/><a:graphic><a:graphicData uri=\"http://schemas.openxmlformats.org/drawingml/2006/picture\"><pic:pic><pic:nvPicPr><pic:cNvPr id=\"0\" name=\"Image\"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed=\"img").append(id).append("\"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x=\"0\" y=\"0\"/><a:ext cx=\"").append(cx).append("\" cy=\"").append(cy).append("\"/></a:xfrm><a:prstGeom prst=\"rect\"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>");
                body.append(paragraph(value(el, "name"), false)); id++;
            } else if (documentItem(el)) body.append(paragraph(value(el, "text"), false));
        }
        files.put("word/document.xml", utf(body.append("<w:sectPr><w:pgSz w:w=\"11906\" w:h=\"16838\"/><w:pgMar w:top=\"1440\" w:right=\"1440\" w:bottom=\"1440\" w:left=\"1440\"/></w:sectPr></w:body></w:document>").toString()));
        files.put("word/_rels/document.xml.rels", utf(rels.append("</Relationships>").toString()));
        return zip(files);
    }
    private static String paragraph(String text, boolean heading) {
        StringBuilder p = new StringBuilder("<w:p><w:pPr><w:spacing w:after=\"180\"/></w:pPr><w:r><w:rPr><w:rFonts w:ascii=\"Calibri\" w:eastAsia=\"Microsoft YaHei\"/><w:sz w:val=\"" + (heading ? 36 : 24) + "\"/>" + (heading ? "<w:b/>" : "") + "</w:rPr>");
        String[] lines = text.split("\\R", -1);
        for (int i = 0; i < lines.length; i++) { if (i > 0) p.append("<w:br/>"); p.append("<w:t xml:space=\"preserve\">").append(xml(lines[i])).append("</w:t>"); }
        return p.append("</w:r></w:p>").toString();
    }
    private static byte[] utf(String s) { return ("<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>" + s).getBytes(StandardCharsets.UTF_8); }
    private static byte[] zip(Map<String, byte[]> files) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        try (ZipOutputStream zip = new ZipOutputStream(out)) { for (var file : files.entrySet()) { zip.putNextEntry(new ZipEntry(file.getKey())); zip.write(file.getValue()); zip.closeEntry(); } }
        return out.toByteArray();
    }
    private static List<JsonNode> boardItems(List<JsonNode> els) {
        return els.stream().filter(el -> is(el, "CARD") || is(el, "IMAGE")).sorted(Comparator.comparingDouble((JsonNode el) -> number(el, "z", 0)).thenComparing(el -> el.path("id").asText())).toList();
    }
    private record BoardRect(double x, double y, double width, double height) {}
    private static BoardRect boardRect(JsonNode el) {
        return new BoardRect(Math.max(0, number(el, "x", 48)), Math.max(0, number(el, "y", 48)),
                Math.max(1, number(el, "w", 220)), Math.max(1, number(el, "h", 150)));
    }
    private static int[] dimensions(List<JsonNode> els) {
        double width = 800, height = 600;
        for (JsonNode el : boardItems(els)) {
            BoardRect rect = boardRect(el);
            width = Math.max(width, Math.ceil(rect.x() + rect.width() + 40));
            height = Math.max(height, Math.ceil(rect.y() + rect.height() + 80));
        }
        // Check the actual geometry before converting to pixels. Clamping individual
        // coordinates silently moves distinct cards on top of one another.
        if (width > 8000 || height > 8000 || width * height > 24_000_000) {
            throw new IllegalArgumentException("白板导出不能超过 8000 像素边长或 2400 万像素，请缩小布局后重试");
        }
        return new int[]{(int) width, (int) height};
    }
    private String boardSvg(String docId, String title, List<JsonNode> els) throws IOException {
        int[] size = dimensions(els);
        StringBuilder svg = new StringBuilder("<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"" + size[0] + "\" height=\"" + size[1] + "\" viewBox=\"0 0 " + size[0] + " " + size[1] + "\"><title>" + xml(title) + "</title><rect width=\"100%\" height=\"100%\" fill=\"white\"/><text x=\"24\" y=\"28\" font-size=\"20\" font-family=\"sans-serif\">" + xml(title) + "</text>");
        for (JsonNode el : boardItems(els)) {
            BoardRect rect = boardRect(el);
            double x=rect.x(), y=rect.y()+40, w=rect.width(), h=rect.height();
            svg.append("<g transform=\"translate(").append(x).append(",").append(y).append(")\">");
            if (is(el,"IMAGE")) svg.append("<image width=\"").append(w).append("\" height=\"").append(h).append("\" href=\"").append(dataUri(docId,value(el,"assetId"))).append("\"/>");
            else {
                svg.append("<rect width=\"").append(w).append("\" height=\"").append(h).append("\" rx=\"6\" fill=\"").append(color(el)).append("\"/>");
                int line=0;
                for(String text : wrap(value(el,"text"), Math.max(1,(int)((w-24)/15)))) svg.append("<text x=\"12\" y=\"").append(26+line++*22).append("\" font-family=\"sans-serif\" font-size=\"15\">").append(xml(text)).append("</text>");
            }
            svg.append("</g>");
        }
        return svg.append("</svg>").toString();
    }
    private byte[] boardPng(String docId, String title, List<JsonNode> els) throws IOException {
        int[] size = dimensions(els);
        BufferedImage canvas = new BufferedImage(size[0],size[1],BufferedImage.TYPE_INT_RGB);
        Graphics2D g = canvas.createGraphics();
        try {
            g.setColor(Color.WHITE); g.fillRect(0,0,size[0],size[1]);
            g.setRenderingHint(RenderingHints.KEY_ANTIALIASING,RenderingHints.VALUE_ANTIALIAS_ON);
            g.setFont(new Font("Microsoft YaHei",Font.BOLD,20)); g.setColor(Color.BLACK); g.drawString(title,24,28);
            g.setFont(new Font("Microsoft YaHei",Font.PLAIN,15));
            for(JsonNode el : boardItems(els)) {
                BoardRect rect = boardRect(el);
                int x=(int)Math.round(rect.x()), y=(int)Math.round(rect.y())+40,
                        w=Math.max(1,(int)Math.round(rect.width())), h=Math.max(1,(int)Math.round(rect.height()));
                if(is(el,"IMAGE")) {
                    BufferedImage bitmap=ImageIO.read(new ByteArrayInputStream(image(docId,value(el,"assetId"))));
                    if(bitmap==null) throw new IOException("图片无法解码");
                    double scale=Math.min((double)w/bitmap.getWidth(),(double)h/bitmap.getHeight());
                    int iw=(int)(bitmap.getWidth()*scale), ih=(int)(bitmap.getHeight()*scale);
                    g.drawImage(bitmap,x+(w-iw)/2,y+(h-ih)/2,iw,ih,null);
                } else {
                    g.setColor(Color.decode(color(el))); g.fillRoundRect(x,y,w,h,6,6); g.setColor(Color.BLACK);
                    int line=0; for(String text : wrap(value(el,"text"),Math.max(1,(w-24)/15))) g.drawString(text,x+12,y+26+line++*22);
                }
            }
        } finally { g.dispose(); }
        ByteArrayOutputStream out=new ByteArrayOutputStream(); ImageIO.write(canvas,"png",out); return out.toByteArray();
    }
    private static String color(JsonNode el) { String value=value(el,"color"); return value.matches("#[0-9a-fA-F]{6}") ? value : "#fff1a8"; }
    private static List<String> wrap(String text,int length) {
        List<String> result=new ArrayList<>();
        for(String line:text.split("\\R",-1)) { if(line.isEmpty()) result.add(""); for(int i=0;i<line.length();i+=length) result.add(line.substring(i,Math.min(line.length(),i+length))); }
        return result;
    }
}
