package com.bishe.server.web;

import com.bishe.server.auth.AccessService;
import com.bishe.server.auth.AuthService;
import com.bishe.server.auth.CurrentUser;
import com.bishe.server.store.ImageAssetRepo;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.core.io.FileSystemResource;
import org.springframework.core.io.Resource;
import org.springframework.http.ContentDisposition;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestPart;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.multipart.MultipartFile;

import java.awt.image.BufferedImage;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import javax.imageio.ImageIO;

/** 图片二进制上传和受空间权限保护的访问接口。WebSocket 只同步返回的元数据。 */
@RestController
@RequestMapping("/api")
public class ImageAssetController {

    private static final long MAX_BYTES = 8L * 1024 * 1024;
    private static final Set<String> ALLOWED_MIME = Set.of("image/png", "image/jpeg", "image/gif");

    private final ImageAssetRepo assets;
    private final AccessService access;
    private final CurrentUser currentUser;
    private final Path uploadRoot;

    public ImageAssetController(ImageAssetRepo assets, AccessService access, CurrentUser currentUser,
                                @Value("${app.upload-dir:./data/uploads}") String uploadDir) {
        this.assets = assets;
        this.access = access;
        this.currentUser = currentUser;
        this.uploadRoot = Path.of(uploadDir).toAbsolutePath().normalize();
    }

    @PostMapping(value = "/docs/{docKey}/images", consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    public ResponseEntity<?> upload(@PathVariable("docKey") String docKey, @RequestPart("file") MultipartFile file) {
        AuthService.UserPub user = currentUser.get();
        AccessService.DocumentAccess permission = access.document(docKey, user);
        if (permission == null) return ResponseEntity.status(403).body(Map.of("msg", "无权访问该空间"));
        if (!permission.canWrite()) return ResponseEntity.status(403).body(Map.of("msg", "只读成员不可上传图片"));
        if (file == null || file.isEmpty()) return ResponseEntity.badRequest().body(Map.of("msg", "请选择图片文件"));
        if (file.getSize() > MAX_BYTES) return ResponseEntity.badRequest().body(Map.of("msg", "图片大小不能超过 8MB"));

        String mime = normalizeMime(file.getContentType());
        if (!ALLOWED_MIME.contains(mime)) {
            return ResponseEntity.badRequest().body(Map.of("msg", "仅支持 PNG、JPEG、GIF 图片"));
        }
        BufferedImage image;
        try (var input = file.getInputStream(); var imageInput = ImageIO.createImageInputStream(input)) {
            var readers = ImageIO.getImageReaders(imageInput);
            if (!readers.hasNext()) return ResponseEntity.badRequest().body(Map.of("msg", "文件内容不是有效图片"));
            var reader = readers.next();
            try {
                reader.setInput(imageInput);
                String actualMime = switch (reader.getFormatName().toLowerCase(Locale.ROOT)) {
                    case "png" -> "image/png";
                    case "jpg", "jpeg" -> "image/jpeg";
                    case "gif" -> "image/gif";
                    default -> "";
                };
                int width = reader.getWidth(0), height = reader.getHeight(0);
                if (!mime.equals(actualMime) || width > 10000 || height > 10000 || (long)width * height > 24_000_000) {
                    return ResponseEntity.badRequest().body(Map.of("msg", "文件格式不匹配或图片超过 2400 万像素"));
                }
                image = reader.read(0);
            } finally { reader.dispose(); }
        } catch (IOException e) {
            return ResponseEntity.badRequest().body(Map.of("msg", "图片内容无法读取"));
        }
        if (image == null || image.getWidth() <= 0 || image.getHeight() <= 0
                || image.getWidth() > 10000 || image.getHeight() > 10000) {
            return ResponseEntity.badRequest().body(Map.of("msg", "图片尺寸无效或超过 10000×10000"));
        }

        String assetId = UUID.randomUUID().toString();
        String extension = extensionFor(mime);
        Path target = uploadRoot.resolve(assetId + "." + extension).normalize();
        if (!target.startsWith(uploadRoot)) return ResponseEntity.badRequest().body(Map.of("msg", "图片路径无效"));
        try {
            Files.createDirectories(uploadRoot);
            try (var input = file.getInputStream()) {
                Files.copy(input, target, StandardCopyOption.REPLACE_EXISTING);
            }
            String originalName = safeName(file.getOriginalFilename());
            assets.insert(new ImageAssetRepo.Asset(assetId, docKey, originalName, mime, file.getSize(),
                    image.getWidth(), image.getHeight(), target.toString(), user.id()));
            return ResponseEntity.ok(Map.of(
                    "assetId", assetId,
                    "docId", docKey,
                    "name", originalName,
                    "mimeType", mime,
                    "size", file.getSize(),
                    "width", image.getWidth(),
                    "height", image.getHeight(),
                    "status", "ready",
                    "url", "/api/assets/" + assetId));
        } catch (IOException | RuntimeException e) {
            try { Files.deleteIfExists(target); } catch (IOException ignored) { }
            return ResponseEntity.internalServerError().body(Map.of("msg", "图片保存失败"));
        }
    }

    @GetMapping("/assets/{assetId}")
    public ResponseEntity<Resource> read(@PathVariable("assetId") String assetId) {
        ImageAssetRepo.Asset asset = assets.find(assetId);
        if (asset == null) return ResponseEntity.notFound().build();
        AuthService.UserPub user = currentUser.get();
        if (access.document(asset.docId(), user) == null) return ResponseEntity.status(403).build();
        Path path = Path.of(asset.storagePath()).toAbsolutePath().normalize();
        if (!path.startsWith(uploadRoot) || !Files.isRegularFile(path)) return ResponseEntity.notFound().build();
        Resource resource = new FileSystemResource(path);
        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.parseMediaType(asset.mimeType()));
        headers.setContentLength(asset.byteSize());
        headers.setContentDisposition(ContentDisposition.inline()
                .filename(asset.originalName(), java.nio.charset.StandardCharsets.UTF_8).build());
        headers.setCacheControl("private, no-store");
        headers.set("X-Content-Type-Options", "nosniff");
        return ResponseEntity.ok().headers(headers).body(resource);
    }

    private static String normalizeMime(String value) {
        if (value == null) return "";
        int semi = value.indexOf(';');
        return (semi >= 0 ? value.substring(0, semi) : value).trim().toLowerCase(Locale.ROOT);
    }

    private static String extensionFor(String mime) {
        return switch (mime) {
            case "image/jpeg" -> "jpg";
            case "image/gif" -> "gif";
            default -> "png";
        };
    }

    private static String safeName(String value) {
        String name = value == null ? "image" : value.replace('\\', '/');
        name = name.substring(name.lastIndexOf('/') + 1);
        name = name.replaceAll("[^\\p{L}\\p{N}._ -]", "_").trim();
        if (name.isBlank()) name = "image";
        return name.length() > 180 ? name.substring(0, 180) : name;
    }
}
