package com.kurisuassistant.android

import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.TextView
import androidx.core.content.ContextCompat
import androidx.recyclerview.widget.RecyclerView
import com.kurisuassistant.android.model.McpServer

class McpServerAdapter(private var servers: List<McpServer>) : 
    RecyclerView.Adapter<McpServerAdapter.McpServerViewHolder>() {

    class McpServerViewHolder(view: View) : RecyclerView.ViewHolder(view) {
        val serverName: TextView = view.findViewById(R.id.textViewServerName)
        val serverStatus: TextView = view.findViewById(R.id.textViewServerStatus)
        val serverCommand: TextView = view.findViewById(R.id.textViewServerCommand)
        val serverArgs: TextView = view.findViewById(R.id.textViewServerArgs)
    }

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): McpServerViewHolder {
        val view = LayoutInflater.from(parent.context)
            .inflate(R.layout.item_mcp_server, parent, false)
        return McpServerViewHolder(view)
    }

    override fun onBindViewHolder(holder: McpServerViewHolder, position: Int) {
        val server = servers[position]
        holder.serverName.text = server.name
        holder.serverStatus.text = server.status.capitalize()
        holder.serverCommand.text = "Command: ${server.command}"
        
        if (server.args.isNotEmpty()) {
            holder.serverArgs.text = "Args: ${server.args.joinToString(" ")}"
            holder.serverArgs.visibility = View.VISIBLE
        } else {
            holder.serverArgs.visibility = View.GONE
        }

        // Set status color
        val statusColor = when (server.status.lowercase()) {
            "available" -> R.color.status_available
            "unavailable" -> R.color.status_unavailable
            else -> R.color.status_configured
        }
        holder.serverStatus.setBackgroundColor(
            ContextCompat.getColor(holder.itemView.context, statusColor)
        )
    }

    override fun getItemCount() = servers.size

    fun updateServers(newServers: List<McpServer>) {
        servers = newServers
        notifyDataSetChanged()
    }
}