package com.bishe.server.testing;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.env.EnvironmentPostProcessor;
import org.springframework.core.Ordered;
import org.springframework.core.env.ConfigurableEnvironment;

import java.util.Arrays;

/** Fails before SQL initialization if integration tests target anything but the dedicated test database. */
public final class TestDatabaseEnvironmentPostProcessor implements EnvironmentPostProcessor, Ordered {

    private static final String TEST_DATABASE = "collab_editor_test";

    @Override
    public void postProcessEnvironment(ConfigurableEnvironment environment, SpringApplication application) {
        if (Arrays.stream(environment.getActiveProfiles()).noneMatch("test"::equals)) {
            return;
        }
        String url = environment.getProperty("spring.datasource.url", "");
        String database = databaseName(url);
        if (!TEST_DATABASE.equalsIgnoreCase(database)) {
            throw new IllegalStateException(
                    "test profile 只能连接 " + TEST_DATABASE + "，当前 JDBC URL 数据库为: " + database);
        }
    }

    private static String databaseName(String url) {
        int query = url.indexOf('?');
        String withoutQuery = query >= 0 ? url.substring(0, query) : url;
        int slash = withoutQuery.lastIndexOf('/');
        return slash >= 0 ? withoutQuery.substring(slash + 1).trim() : "";
    }

    @Override
    public int getOrder() {
        return Ordered.LOWEST_PRECEDENCE;
    }
}
