package com.bishe.server.auth;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.web.multipart.MultipartFile;

import javax.imageio.ImageIO;
import java.awt.RenderingHints;
import java.awt.image.BufferedImage;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.util.Locale;
import java.util.Set;
import java.util.UUID;

/** 头像统一裁剪为 256px PNG，与账户一起持久化。 */
@Service
public class AvatarService {
    private final JdbcTemplate jdbc;

    public AvatarService(JdbcTemplate jdbc) { this.jdbc = jdbc; }

    public void update(long uid, MultipartFile file) {
        byte[] png = normalize(file);
        jdbc.update("UPDATE `user` SET avatar_data = ?, avatar_version = ? WHERE id = ?", png, UUID.randomUUID().toString(), uid);
    }

    public void remove(long uid) {
        jdbc.update("UPDATE `user` SET avatar_data = NULL, avatar_version = NULL WHERE id = ?", uid);
    }

    public byte[] read(long uid) {
        var rows = jdbc.query("SELECT avatar_data FROM `user` WHERE id = ?", (rs, index) -> rs.getBytes(1), uid);
        return rows.isEmpty() ? null : rows.get(0);
    }

    static byte[] normalize(MultipartFile file) {
        if (file == null || file.isEmpty()) throw new IllegalArgumentException("请选择头像图片");
        if (file.getSize() > 2L * 1024 * 1024) throw new IllegalArgumentException("头像大小不能超过 2MB");
        String mime = file.getContentType() == null ? "" : file.getContentType().split(";", 2)[0].trim().toLowerCase(Locale.ROOT);
        if (!Set.of("image/png", "image/jpeg").contains(mime)) throw new IllegalArgumentException("头像仅支持 PNG、JPEG 图片");
        try (var stream = file.getInputStream(); var input = ImageIO.createImageInputStream(stream)) {
            if (input == null) throw new IllegalArgumentException("文件内容不是有效图片");
            var readers = ImageIO.getImageReaders(input);
            if (!readers.hasNext()) throw new IllegalArgumentException("文件内容不是有效图片");
            var reader = readers.next();
            try {
                reader.setInput(input);
                String format = reader.getFormatName().toLowerCase(Locale.ROOT);
                String actualMime = switch (format) {
                    case "png" -> "image/png";
                    case "jpg", "jpeg" -> "image/jpeg";
                    default -> "";
                };
                if (!mime.equals(actualMime)) throw new IllegalArgumentException("图片格式与文件内容不匹配");
                int width = reader.getWidth(0), height = reader.getHeight(0);
                if (width < 1 || height < 1 || width > 4096 || height > 4096 || (long) width * height > 16_000_000) {
                    throw new IllegalArgumentException("头像边长不能超过 4096 像素，且不能超过 1600 万像素");
                }
                BufferedImage source = reader.read(0);
                BufferedImage target = new BufferedImage(256, 256, BufferedImage.TYPE_INT_ARGB);
                var graphics = target.createGraphics();
                try {
                    graphics.setRenderingHint(RenderingHints.KEY_INTERPOLATION, RenderingHints.VALUE_INTERPOLATION_BICUBIC);
                    int side = Math.min(width, height), x = (width - side) / 2, y = (height - side) / 2;
                    graphics.drawImage(source, 0, 0, 256, 256, x, y, x + side, y + side, null);
                } finally { graphics.dispose(); }
                var output = new ByteArrayOutputStream();
                if (!ImageIO.write(target, "png", output)) throw new IllegalArgumentException("头像图片无法处理");
                return output.toByteArray();
            } finally { reader.dispose(); }
        } catch (IOException error) {
            throw new IllegalArgumentException("头像图片无法读取，请更换图片", error);
        }
    }
}
