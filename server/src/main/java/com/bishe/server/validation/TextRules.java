package com.bishe.server.validation;

/** 共享的人类可见文本边界规则。 */
public final class TextRules {

    private TextRules() {
    }

    public static boolean containsControl(String value) {
        return value != null && value.codePoints().anyMatch(Character::isISOControl);
    }
}
