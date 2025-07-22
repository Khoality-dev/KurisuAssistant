package com.kurisuassistant.android

import android.os.Bundle
import android.view.View
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import androidx.swiperefreshlayout.widget.SwipeRefreshLayout
import com.google.android.material.appbar.MaterialToolbar
import com.kurisuassistant.android.model.McpServer
import com.kurisuassistant.android.utils.HttpClient
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject

class MCPToolsActivity : AppCompatActivity() {
    private lateinit var recyclerView: RecyclerView
    private lateinit var adapter: McpServerAdapter
    private lateinit var swipeRefresh: SwipeRefreshLayout
    private lateinit var statusText: TextView
    private val scope = CoroutineScope(Dispatchers.Main)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_mcp_tools)

        val toolbar = findViewById<MaterialToolbar>(R.id.toolbar)
        setSupportActionBar(toolbar)
        supportActionBar?.setDisplayHomeAsUpEnabled(true)
        supportActionBar?.title = "MCP Tools"

        recyclerView = findViewById(R.id.recyclerViewMcpServers)
        swipeRefresh = findViewById(R.id.swipeRefresh)
        statusText = findViewById(R.id.textViewStatus)

        adapter = McpServerAdapter(emptyList())
        recyclerView.adapter = adapter
        recyclerView.layoutManager = LinearLayoutManager(this)

        swipeRefresh.setOnRefreshListener {
            loadMcpServers()
        }

        loadMcpServers()
    }

    override fun onSupportNavigateUp(): Boolean {
        onBackPressed()
        return true
    }

    private fun loadMcpServers() {
        scope.launch {
            try {
                statusText.text = "Loading MCP servers..."
                statusText.visibility = View.VISIBLE
                recyclerView.visibility = View.GONE

                val servers = withContext(Dispatchers.IO) {
                    fetchMcpServers()
                }

                if (servers.isNotEmpty()) {
                    adapter.updateServers(servers)
                    statusText.visibility = View.GONE
                    recyclerView.visibility = View.VISIBLE
                } else {
                    statusText.text = "No MCP servers configured"
                    statusText.visibility = View.VISIBLE
                    recyclerView.visibility = View.GONE
                }

            } catch (e: Exception) {
                statusText.text = "Error loading MCP servers: ${e.message}"
                statusText.visibility = View.VISIBLE
                recyclerView.visibility = View.GONE
                Toast.makeText(this@MCPToolsActivity, "Failed to load MCP servers", Toast.LENGTH_SHORT).show()
            } finally {
                swipeRefresh.isRefreshing = false
            }
        }
    }

    private suspend fun fetchMcpServers(): List<McpServer> {
        val llmHubUrl = Settings.getLlmHubUrl()
        val token = Settings.getToken()

        if (llmHubUrl.isEmpty() || token.isEmpty()) {
            throw Exception("LLM Hub URL or token not configured")
        }

        val response = HttpClient.get("$llmHubUrl/mcp-servers", token)
        val jsonResponse = JSONObject(response)
        val serversArray = jsonResponse.getJSONArray("servers")

        val servers = mutableListOf<McpServer>()
        for (i in 0 until serversArray.length()) {
            val serverJson = serversArray.getJSONObject(i)
            val argsArray = serverJson.getJSONArray("args")
            val args = mutableListOf<String>()
            for (j in 0 until argsArray.length()) {
                args.add(argsArray.getString(j))
            }

            servers.add(
                McpServer(
                    name = serverJson.getString("name"),
                    command = serverJson.getString("command"),
                    args = args,
                    status = serverJson.getString("status")
                )
            )
        }

        return servers
    }
}