package com.kurisu.assistant.ui.settings

import com.kurisu.assistant.data.model.Tool
import com.kurisu.assistant.data.model.ToolsResponse

/**
 * Whether a tool only looks — what the Read only permission mode runs (#360). A
 * tool that does not say counts as changing something.
 */
enum class ToolEffect(val label: String) { READS("Reads"), CHANGES("Changes") }

data class CatalogTool(val name: String, val description: String, val effect: ToolEffect, val tool: Tool)

data class CatalogGroup(val id: String, val name: String, val tools: List<CatalogTool>)

/**
 * What Tools & MCP lists (#360): every tool the assistant has, the server's own
 * by feature and the user's MCP servers by server, as the desktop's Settings ›
 * Tools does (`toolCatalog.ts`). Nothing here turns a tool on or off — every
 * tool is always offered, and the permission mode beside the chat input decides
 * which calls wait. A phone lends the assistant no tools of its own.
 */
data class ToolCatalog(
    val kurisu: List<CatalogGroup> = emptyList(),
    val mcp: List<CatalogGroup> = emptyList(),
) {
    companion object {
        private val FEATURES: List<Triple<String, String, (String) -> Boolean>> = listOf(
            Triple("calendar", "Calendar") { n: String -> n.startsWith("calendar_") },
            Triple("tasks", "Tasks") { n: String -> n.startsWith("task_") },
            Triple("drive", "Kurisu Drive") { n: String -> n.startsWith("drive_") },
            Triple("memory", "History and recall") { n: String -> n.startsWith("history_") || n.startsWith("recall_") },
        )

        private fun Tool.toCatalog() = CatalogTool(
            name = function.name,
            description = function.description,
            effect = if (readOnly) ToolEffect.READS else ToolEffect.CHANGES,
            tool = this,
        )

        fun from(response: ToolsResponse): ToolCatalog {
            val byFeature = FEATURES.associate { it.first to mutableListOf<CatalogTool>() }
            val other = mutableListOf<CatalogTool>()
            for (tool in response.serverTools) {
                val feature = FEATURES.firstOrNull { it.third(tool.function.name) }
                (if (feature == null) other else byFeature.getValue(feature.first)) += tool.toCatalog()
            }
            val kurisu = FEATURES.map { CatalogGroup(it.first, it.second, byFeature.getValue(it.first)) } +
                CatalogGroup("other", "Other", other)
            val mcp = response.mcpServers.orEmpty().map { (server, tools) ->
                CatalogGroup("mcp:$server", server, tools.map { it.toCatalog() })
            }
            return ToolCatalog(
                kurisu = kurisu.filter { it.tools.isNotEmpty() },
                mcp = mcp.filter { it.tools.isNotEmpty() },
            )
        }
    }
}
