package com.soms.client

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class NativeMentionLogicTest {
    @Test
    fun `finds the query immediately before the cursor`() {
        assertEquals(MentionQuery(3, "张"), NativeMentionLogic.query("你好 @张", 5))
        assertEquals(MentionQuery(0, ""), NativeMentionLogic.query("@", 1))
        assertNull(NativeMentionLogic.query("email@张", 7))
    }

    @Test
    fun `validates UTF-16 ranges including emoji`() {
        val text = "😀 @张三"
        assertEquals(
            listOf(MentionRange(3, 6, "user", "zhangsan@example.com", "张三")),
            NativeMentionLogic.validRanges(
                text,
                listOf(MentionRange(3, 6, "user", "zhangsan@example.com", "张三")),
            ),
        )
    }

    @Test
    fun `drops stale and overlapping ranges`() {
        assertEquals(
            emptyList<MentionRange>(),
            NativeMentionLogic.validRanges(
                "@张三",
                listOf(MentionRange(0, 2, "user", "a@example.com", "张三")),
            ),
        )
    }
}
