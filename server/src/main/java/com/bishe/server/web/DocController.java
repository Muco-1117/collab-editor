package com.bishe.server.web;

import com.bishe.server.store.DocRepo;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 文档 CRUD（REST）。元素内容本身走 WS /ws/collab 实时通道。
 */
@RestController
@RequestMapping("/api/docs")
public class DocController {

    private final DocRepo repo;

    public DocController(DocRepo repo) {
        this.repo = repo;
    }

    @GetMapping
    public List<Map<String, Object>> list() {
        return repo.list();
    }

    @PostMapping
    public Map<String, Object> create(@RequestBody(required = false) Map<String, String> body) {
        String title = body == null ? "" : body.getOrDefault("title", "");
        String key = repo.create(title);
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("docKey", key);
        out.put("title", title);
        return out;
    }

    @GetMapping("/{docKey}")
    public ResponseEntity<?> get(@PathVariable("docKey") String docKey) {
        Map<String, Object> m = repo.get(docKey);
        return m == null ? ResponseEntity.notFound().build() : ResponseEntity.ok(m);
    }

    @DeleteMapping("/{docKey}")
    public ResponseEntity<?> delete(@PathVariable("docKey") String docKey) {
        boolean ok = repo.delete(docKey);
        return ok ? ResponseEntity.ok(Map.of("deleted", true)) : ResponseEntity.notFound().build();
    }
}