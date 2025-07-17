package com.kurisuassistant.android.model

data class McpServer(
    val name: String,
    val command: String,
    val args: List<String>,
    val status: String
)