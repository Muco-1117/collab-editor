package com.bishe.server.web;

import com.bishe.server.store.ImageAssetRepo;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;
import org.junit.jupiter.params.provider.ValueSource;
import org.w3c.dom.Document;

import javax.imageio.ImageIO;
import javax.xml.XMLConstants;
import javax.xml.parsers.DocumentBuilderFactory;
import java.awt.Color;
import java.awt.image.BufferedImage;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

import static org.junit.jupiter.api.Assertions.*;

/** Real export bytes and image geometry; no Spring, database or browser required. */
class ContentExportBoundaryTest {

    private static final ObjectMapper JSON = new ObjectMapper();
    private static final String DRAWING = "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing";
    private static final String DRAWING_MAIN = "http://schemas.openxmlformats.org/drawingml/2006/main";
    private static final String SVG = "http://www.w3.org/2000/svg";
    @TempDir Path directory;

    private ContentExportService exporter(Map<String, ImageAssetRepo.Asset> data) {
        return new ContentExportService(new ImageAssetRepo(null) {
            @Override public Asset find(String assetId) { return data.get(assetId); }
        }, directory.toString());
    }

    @ParameterizedTest
    @ValueSource(strings = {"=SUM(1,\n2)", " \t=SUM(1,\r\n2)", "+SUM(1,\n2)", "-3\n备注", "@SUM(1,\n2)", "\u2002=1\n说明"})
    void multilineFormulaLookingTasksAreExportedAsText(String task) {
        String title = "=项目名称\n第二行", column = "\t+列表\n\"引号\"";
        ArrayNode snapshot = JSON.createArrayNode()
                .add(element("column", "COLUMN", Map.of("title", column, "order", 1)))
                .add(element("card", "CARD", Map.of("column", "column", "text", task, "order", 2)));
        var file = exporter(Map.of()).generate("doc", title, "kanban", "csv", snapshot);
        List<List<String>> rows = csvRows(new String(file.bytes(), StandardCharsets.UTF_8));
        assertEquals(2, rows.size());
        assertEquals(8, rows.get(1).size());
        assertEquals("'" + title, rows.get(1).get(0));
        assertEquals("'" + column, rows.get(1).get(1));
        assertEquals("'" + task, rows.get(1).get(3));
        assertEquals("2", rows.get(1).get(4));
    }

    @Test
    void csvPreservesOrdinaryMultilineTextAndXlsxUsesStringCellsForFormulaText() throws Exception {
        String text = "讨论中文,\"引号\"\r\n第二行 +1 与 =2";
        ArrayNode snapshot = JSON.createArrayNode().add(element("card", "CARD", Map.of("text", text, "order", 1)));
        List<List<String>> rows = csvRows(new String(exporter(Map.of()).generate("doc", "项目", "kanban", "csv", snapshot).bytes(), StandardCharsets.UTF_8));
        assertEquals(text, rows.get(1).get(3));
        snapshot = JSON.createArrayNode().add(element("card", "CARD", Map.of("text", "=SUM(1,\n2)", "order", 1)));
        Map<String, byte[]> packageFiles = unzip(exporter(Map.of()).generate("doc", "项目", "kanban", "xlsx", snapshot).bytes());
        Document sheet = xml(packageFiles.get("xl/worksheets/sheet1.xml"));
        assertEquals(0, sheet.getElementsByTagName("f").getLength());
        assertTrue(sheet.getDocumentElement().getTextContent().contains("=SUM(1,\n2)"));
        var cells = sheet.getElementsByTagName("c");
        for (int i = 0; i < cells.getLength(); i++) {
            assertEquals("inlineStr", cells.item(i).getAttributes().getNamedItem("t").getNodeValue());
        }
    }

    @ParameterizedTest
    @CsvSource({"100,1000", "1000,100", "1600,2000", "24,16", "1,10000"})
    void docxImagesKeepTheirAspectRatioAndFitBothPageBounds(int sourceWidth, int sourceHeight) throws Exception {
        Path source = directory.resolve("original.png");
        ImageIO.write(new BufferedImage(sourceWidth, sourceHeight, BufferedImage.TYPE_INT_RGB), "png", source.toFile());
        ImageAssetRepo.Asset image = new ImageAssetRepo.Asset("asset", "doc", "纵长<&>图片.png", "image/png",
                Files.size(source), sourceWidth, sourceHeight, source.toString(), 1);
        ArrayNode snapshot = JSON.createArrayNode().add(element("image", "IMAGE", Map.of("assetId", "asset", "name", image.originalName(), "order", 1)));
        Map<String, byte[]> files = unzip(exporter(Map.of("asset", image)).generate("doc", "标题<&>", "doc", "docx", snapshot).bytes());
        Document document = xml(files.get("word/document.xml"));
        var extent = document.getElementsByTagNameNS(DRAWING, "extent").item(0).getAttributes();
        long width = Long.parseLong(extent.getNamedItem("cx").getNodeValue());
        long height = Long.parseLong(extent.getNamedItem("cy").getNodeValue());
        assertTrue(width > 0 && height > 0);
        assertTrue(width <= 550L * 9525 && height <= 650L * 9525, "图像须同时满足横向和纵向页内范围");
        assertTrue(width <= sourceWidth * 9525L && height <= sourceHeight * 9525L, "小图不应无故放大");
        double sourceRatio = (double) sourceWidth / sourceHeight;
        assertEquals(sourceRatio, (double) width / height, sourceRatio * 0.001, "必须等比缩放");
        var pictureExtent = document.getElementsByTagNameNS(DRAWING_MAIN, "ext").item(0).getAttributes();
        assertEquals(Long.toString(width), pictureExtent.getNamedItem("cx").getNodeValue());
        assertEquals(Long.toString(height), pictureExtent.getNamedItem("cy").getNodeValue());
        assertTrue(document.getDocumentElement().getTextContent().contains("标题<&>"));
        BufferedImage embedded = ImageIO.read(new ByteArrayInputStream(files.get("word/media/image1.png")));
        assertEquals(sourceWidth, embedded.getWidth());
        assertEquals(sourceHeight, embedded.getHeight());
        if (sourceWidth == 100 && sourceHeight == 1000) {
            assertEquals(65L * 9525, width);
            assertEquals(650L * 9525, height);
        }
    }

    @Test
    void largeBoardKeepsDistinctPositionsInSvgAndPng() throws Exception {
        ArrayNode snapshot = JSON.createArrayNode()
                .add(element("left", "CARD", Map.of("x", 7100, "y", 20, "w", 220, "h", 150, "color", "#ff0000", "text", "左侧")))
                .add(element("right", "CARD", Map.of("x", 7400, "y", 20, "w", 220, "h", 150, "color", "#0000ff", "text", "右侧")));
        ContentExportService service = exporter(Map.of());
        Document svg = xml(service.generate("doc", "实际坐标", "board", "svg", snapshot).bytes());
        assertEquals("7660", svg.getDocumentElement().getAttribute("width"));
        var groups = svg.getElementsByTagNameNS(SVG, "g");
        assertEquals("translate(7100.0,60.0)", groups.item(0).getAttributes().getNamedItem("transform").getNodeValue());
        assertEquals("translate(7400.0,60.0)", groups.item(1).getAttributes().getNamedItem("transform").getNodeValue());
        BufferedImage png = ImageIO.read(new ByteArrayInputStream(service.generate("doc", "实际坐标", "board", "png", snapshot).bytes()));
        assertEquals(7660, png.getWidth());
        assertEquals(600, png.getHeight());
        assertEquals(Color.RED.getRGB(), png.getRGB(7200, 160));
        assertEquals(Color.BLUE.getRGB(), png.getRGB(7500, 160));
        assertEquals(Color.WHITE.getRGB(), png.getRGB(7350, 160), "两张便签之间的实际间距必须保留");
    }

    @Test
    void svgPreservesFractionalCoordinatesAndDimensions() throws Exception {
        ArrayNode snapshot = JSON.createArrayNode().add(element("card", "CARD",
                Map.of("x", 7100.25, "y", 21.5, "w", 220.5, "h", 150.25, "text", "精确位置")));
        Document svg = xml(exporter(Map.of()).generate("doc", "坐标", "board", "svg", snapshot).bytes());
        assertEquals("7361", svg.getDocumentElement().getAttribute("width"));
        assertEquals("translate(7100.25,61.5)", svg.getElementsByTagNameNS(SVG, "g").item(0)
                .getAttributes().getNamedItem("transform").getNodeValue());
        var card = svg.getElementsByTagNameNS(SVG, "rect").item(1).getAttributes();
        assertEquals("220.5", card.getNamedItem("width").getNodeValue());
        assertEquals("150.25", card.getNamedItem("height").getNodeValue());
    }

    @ParameterizedTest
    @CsvSource({"8001,0,220,150", "0,8001,220,150", "0,0,8001,150", "0,0,220,8001", "4900,4900,220,150", "1.0E30,0,220,150"})
    void oversizedBoardsAreRejectedBeforeRasterAllocationOrSilentRelocation(double x, double y, double width, double height) {
        ArrayNode snapshot = JSON.createArrayNode().add(element("card", "CARD", Map.of("x", x, "y", y, "w", width, "h", height)));
        ContentExportService service = exporter(Map.of());
        for (String format : List.of("svg", "png")) {
            IllegalArgumentException failure = assertThrows(IllegalArgumentException.class,
                    () -> service.generate("doc", "超出尺寸", "board", format, snapshot));
            assertTrue(failure.getMessage().contains("8000"));
            assertTrue(failure.getMessage().contains("2400"));
        }
    }

    @Test
    void deletedOversizedElementsCannotBlockExport() throws Exception {
        ArrayNode snapshot = JSON.createArrayNode()
                .add(element("deleted", "CARD", Map.of("x", 100000, "#tombstone", true)))
                .add(element("visible", "CARD", Map.of("x", 50, "y", 30, "text", "仍有效")));
        Document svg = xml(exporter(Map.of()).generate("doc", "有效内容", "board", "svg", snapshot).bytes());
        assertEquals("800", svg.getDocumentElement().getAttribute("width"));
        assertEquals(1, svg.getElementsByTagNameNS(SVG, "g").getLength());
    }

    private static ObjectNode element(String id, String type, Map<String, Object> values) {
        ObjectNode element = JSON.createObjectNode().put("id", id).put("type", type);
        ObjectNode fields = element.putObject("fields");
        values.forEach((name, value) -> fields.putObject(name).set("value", JSON.valueToTree(value)));
        return element;
    }

    private static Document xml(byte[] bytes) throws Exception {
        DocumentBuilderFactory factory = DocumentBuilderFactory.newInstance();
        factory.setNamespaceAware(true);
        factory.setFeature(XMLConstants.FEATURE_SECURE_PROCESSING, true);
        factory.setAttribute(XMLConstants.ACCESS_EXTERNAL_DTD, "");
        factory.setAttribute(XMLConstants.ACCESS_EXTERNAL_SCHEMA, "");
        return factory.newDocumentBuilder().parse(new ByteArrayInputStream(bytes));
    }

    private static Map<String, byte[]> unzip(byte[] bytes) throws IOException {
        Map<String, byte[]> files = new HashMap<>();
        try (ZipInputStream zip = new ZipInputStream(new ByteArrayInputStream(bytes))) {
            for (ZipEntry entry; (entry = zip.getNextEntry()) != null; ) files.put(entry.getName(), zip.readAllBytes());
        }
        return files;
    }

    private static List<List<String>> csvRows(String csv) {
        List<List<String>> rows = new ArrayList<>();
        List<String> row = new ArrayList<>();
        StringBuilder cell = new StringBuilder();
        boolean quoted = false;
        for (int index = csv.startsWith("\uFEFF") ? 1 : 0; index < csv.length(); index++) {
            char next = csv.charAt(index);
            if (next == '"') {
                if (quoted && index + 1 < csv.length() && csv.charAt(index + 1) == '"') { cell.append('"'); index++; }
                else quoted = !quoted;
            } else if (!quoted && next == ',') {
                row.add(cell.toString()); cell.setLength(0);
            } else if (!quoted && next == '\n') {
                row.add(cell.toString()); cell.setLength(0); rows.add(row); row = new ArrayList<>();
            } else if (quoted || next != '\r') cell.append(next);
        }
        assertFalse(quoted, "CSV 引号必须闭合");
        if (cell.length() > 0 || !row.isEmpty()) { row.add(cell.toString()); rows.add(row); }
        return rows;
    }
}
