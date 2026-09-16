package com.bishe.server;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

/**
 * 多人实时协同编辑系统 —— 服务端入口。
 */
@SpringBootApplication
public class CollabServerApplication {

    public static void main(String[] args) {
        SpringApplication.run(CollabServerApplication.class, args);
    }
}