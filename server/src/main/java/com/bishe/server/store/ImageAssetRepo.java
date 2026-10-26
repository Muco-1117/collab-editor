package com.bishe.server.store;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

import java.util.List;
import java.util.Map;

/** 图片资源元数据仓储。文件本体由 ImageAssetController 保存在本地资源目录。 */
@Repository
public class ImageAssetRepo {

    public record Asset(String assetId, String docId, String originalName, String mimeType,
                         long byteSize, int width, int height, String storagePath, long createdBy) {}

    private final JdbcTemplate jdbc;

    public ImageAssetRepo(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    public void insert(Asset asset) {
        jdbc.update("""
                INSERT INTO image_asset(asset_id, doc_id, original_name, mime_type, byte_size,
                                        width, height, storage_path, created_by)
                VALUES(?,?,?,?,?,?,?,?,?)
                """, asset.assetId(), asset.docId(), asset.originalName(), asset.mimeType(),
                asset.byteSize(), asset.width(), asset.height(), asset.storagePath(), asset.createdBy());
    }

    public Asset find(String assetId) {
        List<Map<String, Object>> rows = jdbc.queryForList("""
                SELECT asset_id, doc_id, original_name, mime_type, byte_size, width, height,
                       storage_path, created_by
                FROM image_asset WHERE asset_id = ?
                """, assetId);
        if (rows.isEmpty()) return null;
        Map<String, Object> row = rows.get(0);
        return new Asset(
                String.valueOf(row.get("asset_id")), String.valueOf(row.get("doc_id")),
                String.valueOf(row.get("original_name")), String.valueOf(row.get("mime_type")),
                ((Number) row.get("byte_size")).longValue(), ((Number) row.get("width")).intValue(),
                ((Number) row.get("height")).intValue(), String.valueOf(row.get("storage_path")),
                ((Number) row.get("created_by")).longValue());
    }
}
