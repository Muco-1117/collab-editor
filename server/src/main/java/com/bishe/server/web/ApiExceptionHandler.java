package com.bishe.server.web;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.dao.DataAccessException;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.web.bind.MissingServletRequestParameterException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.method.annotation.MethodArgumentTypeMismatchException;

import java.util.Map;

/** REST 错误统一为简洁 JSON，避免把实现细节或 SQL 信息暴露给客户端。 */
@RestControllerAdvice
public class ApiExceptionHandler {

    private static final Logger log = LoggerFactory.getLogger(ApiExceptionHandler.class);

    @ExceptionHandler(org.springframework.web.multipart.MaxUploadSizeExceededException.class)
    public ResponseEntity<?> uploadTooLarge(Exception ignored) {
        return ResponseEntity.status(413).body(Map.of("msg", "图片大小不能超过 8MB"));
    }

    @ExceptionHandler({HttpMessageNotReadableException.class,
            MissingServletRequestParameterException.class,
            MethodArgumentTypeMismatchException.class})
    public ResponseEntity<?> badRequest(Exception ignored) {
        return ResponseEntity.badRequest().body(Map.of("msg", "请求参数格式错误"));
    }

    @ExceptionHandler(DataAccessException.class)
    public ResponseEntity<?> databaseUnavailable(DataAccessException error) {
        log.error("数据库操作失败", error);
        return ResponseEntity.status(HttpStatus.SERVICE_UNAVAILABLE)
                .body(Map.of("msg", "数据库暂时不可用，请稍后重试"));
    }
}
