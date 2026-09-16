package com.bishe.engine;

/**
 * 元素类型 —— 三类协同应用共用同一元素模型：
 * 文档为文本块元素、白板为卡片（含几何字段）、看板为列/卡片（含列归属字段）。
 */
public enum ElementType {
    /** 文档文本块 */
    TEXT,
    /** 白板卡片（fields: x/y/w/h/text） */
    CARD,
    /** 看板卡片（fields: columnId/text） */
    TASK,
    /** 看板列 / 空间容器 */
    COLUMN
}