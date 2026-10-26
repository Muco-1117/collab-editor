# Server tests

Spring integration tests use the `test` profile and a dedicated MySQL 8 database named
`collab_editor_test`. The profile never targets the development database `collab_editor`.
A startup guard rejects any JDBC URL whose database name is not exactly
`collab_editor_test`, before schema initialization or cleanup runs.

The default JDBC URL is:

```text
jdbc:mysql://localhost:3306/collab_editor_test?createDatabaseIfNotExist=true&useUnicode=true&characterEncoding=utf8&serverTimezone=Asia/Shanghai
```

Configuration precedence is:

- URL: `TEST_DB_URL`, then `DB_URL`, then the generated URL using
  `TEST_DB_HOST`/`DB_HOST` and `TEST_DB_PORT`/`DB_PORT`.
- User: `TEST_DB_USER`, then `DB_USER`, then `root`.
- Password: `TEST_DB_PASSWORD`, then `DB_PASSWORD`, then empty.

`application-local.yml` is intentionally not imported because it could also override the
JDBC URL. For local runs, expose only its ignored password to the test process:

```powershell
$env:TEST_DB_PASSWORD = '<application-local.yml 中的 password>'
mvn.cmd test
Remove-Item Env:TEST_DB_PASSWORD
```

`schema-test.sql` recreates the complete schema idempotently inside
`collab_editor_test` whenever a new Spring test context starts. No test cleanup touches
`collab_editor`.
