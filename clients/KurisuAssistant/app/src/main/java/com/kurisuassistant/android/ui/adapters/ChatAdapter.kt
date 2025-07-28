package com.kurisuassistant.android

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.text.method.LinkMovementMethod
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.ImageView
import android.widget.TextView
import androidx.recyclerview.widget.RecyclerView
import io.noties.markwon.Markwon
import io.noties.markwon.linkify.LinkifyPlugin
import com.kurisuassistant.android.model.ChatMessage
import java.text.SimpleDateFormat
import java.time.Instant
import java.time.LocalDateTime
import java.time.ZoneId
import java.util.*

/**
 * RecyclerView adapter displaying chat messages.
 */
class ChatAdapter(
    private val context: Context,
    private var messages: List<ChatMessage>?,
) : RecyclerView.Adapter<RecyclerView.ViewHolder>() {

    companion object {
        private const val USER = 0
        private const val ASSISTANT = 1
        private const val TOOL = 2
        private var instance: ChatAdapter? = null
        
        fun showTemporarySTT(text: String) {
            instance?.showTemporaryMessage(text, 3000)
        }
    }

    private var responding = false
    private var ellipsis = ""
    private val markwon = Markwon.builder(context)
        .usePlugin(LinkifyPlugin.create())
        .build()
    private val handler = Handler(Looper.getMainLooper())
    private var tempMessage: ChatMessage? = null
    private val tempMessages = mutableListOf<ChatMessage>()
    private val timeFormat = SimpleDateFormat("HH:mm dd-MM-yyyy", Locale.getDefault())
    private val localZone = ZoneId.systemDefault()
    
    init {
        instance = this
    }
    private val animateRunnable = object : Runnable {
        override fun run() {
            ellipsis = when (ellipsis.length) {
                0 -> "."
                1 -> ".."
                2 -> "..."
                else -> ""
            }
            val allMessages = getAllMessages()
            if (allMessages.isNotEmpty()) notifyItemChanged(allMessages.lastIndex)
            if (responding) {
                handler.postDelayed(this, 500)
            }
        }
    }

    fun update(newMessages: List<ChatMessage>?) {
        messages = newMessages
        notifyDataSetChanged()
    }
    
    private fun formatTimeForDisplay(timestamp: String): String {
        return try {
            val instant = when {
                // ISO format with Z (UTC)
                timestamp.endsWith("Z") -> Instant.parse(timestamp)
                // ISO format with timezone offset
                timestamp.contains("T") && (timestamp.contains("+") || timestamp.contains("-")) -> Instant.parse(timestamp)
                // Simple ISO format without timezone (assume UTC)
                timestamp.contains("T") -> Instant.parse(timestamp + "Z")
                // Try to parse as epoch timestamp
                timestamp.all { it.isDigit() } -> Instant.ofEpochMilli(timestamp.toLong())
                // Date only format YYYY-MM-DD
                timestamp.matches(Regex("\\d{4}-\\d{2}-\\d{2}")) -> Instant.parse(timestamp + "T00:00:00Z")
                // Date and time format without T (YYYY-MM-DD HH:mm:ss)
                timestamp.contains(" ") -> {
                    val parts = timestamp.split(" ")
                    if (parts.size >= 2) {
                        Instant.parse("${parts[0]}T${parts[1]}Z")
                    } else null
                }
                else -> null
            }
            
            instant?.let { 
                val localDateTime = LocalDateTime.ofInstant(it, localZone)
                timeFormat.format(Date.from(localDateTime.atZone(localZone).toInstant()))
            } ?: timestamp
            
        } catch (e: Exception) {
            // If all parsing fails, try to extract a readable format from the original
            if (timestamp.contains("T")) {
                try {
                    // Just return the part before T and format it nicely
                    val datePart = timestamp.split("T")[0]
                    val timePart = timestamp.split("T")[1].split(".")[0].split("Z")[0]
                    "$timePart $datePart"
                } catch (ex: Exception) {
                    timestamp
                }
            } else {
                timestamp
            }
        }
    }
    
    fun showTemporaryMessage(text: String, durationMs: Long = 3000) {
        handler.post {
            val tempMsg = ChatMessage(
                text = text,
                role = "user",
                isTemporary = true
            )
            tempMessages.add(tempMsg)
            notifyItemInserted(getAllMessages().size - 1)
            
            handler.postDelayed({
                removeTemporaryMessage(tempMsg)
            }, durationMs)
        }
    }
    
    private fun removeTemporaryMessage(tempMsg: ChatMessage) {
        handler.post {
            val allMessages = getAllMessages()
            val actualIndex = allMessages.indexOf(tempMsg)
            val tempIndex = tempMessages.indexOf(tempMsg)
            
            if (tempIndex >= 0 && actualIndex >= 0) {
                tempMessages.removeAt(tempIndex)
                notifyItemRemoved(actualIndex)
            }
        }
    }
    
    private fun getAllMessages(): List<ChatMessage> {
        return (messages ?: emptyList()) + tempMessages
    }
    
    fun onDestroy() {
        handler.removeCallbacksAndMessages(null)
        if (instance == this) {
            instance = null
        }
    }

    fun setResponding(value: Boolean) {
        if (responding == value) return
        responding = value
        if (value) {
            handler.post(animateRunnable)
        } else {
            handler.removeCallbacks(animateRunnable)
            ellipsis = ""
            val allMessages = getAllMessages()
            if (allMessages.isNotEmpty()) notifyItemChanged(allMessages.lastIndex)
        }
    }

    override fun getItemViewType(position: Int): Int {
        val message = getAllMessages()[position]
        return when {
            message.isUser -> USER
            message.isTool -> TOOL
            else -> ASSISTANT
        }
    }

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): RecyclerView.ViewHolder {
        val inflater = LayoutInflater.from(parent.context)
        return when (viewType) {
            USER -> {
                val view = inflater.inflate(R.layout.item_user_message, parent, false)
                UserHolder(view)
            }
            TOOL -> {
                val view = inflater.inflate(R.layout.item_tool_message, parent, false)
                ToolHolder(view)
            }
            else -> {
                val view = inflater.inflate(R.layout.item_assistant_message, parent, false)
                AssistantHolder(view)
            }
        }
    }

    override fun onBindViewHolder(holder: RecyclerView.ViewHolder, position: Int) {
        val allMessages = getAllMessages()
        val msg = allMessages[position]
        when (holder) {
            is UserHolder -> {
                val displayText = msg.text
                markwon.setMarkdown(holder.text, displayText)
                holder.text.movementMethod = LinkMovementMethod.getInstance()
                holder.time.text = msg.createdAt?.let { formatTimeForDisplay(it) } ?: ""
                holder.time.visibility = View.GONE
                holder.text.setOnClickListener {
                    holder.time.visibility =
                        if (holder.time.visibility == View.VISIBLE) View.GONE else View.VISIBLE
                }
                
                // Style temporary messages differently
                if (msg.isTemporary) {
                    holder.text.alpha = 0.6f
                } else {
                    holder.text.alpha = 1.0f
                }
                
                val uri = AvatarManager.getUserAvatarUri()
                if (uri != null) holder.avatar.setImageURI(uri)
                else holder.avatar.setImageResource(R.drawable.avatar_user)
            }
            is AssistantHolder -> {
                var text = msg.text
                if (responding && position == allMessages.lastIndex) {
                    text += ellipsis
                }
                markwon.setMarkdown(holder.text, text)
                holder.text.movementMethod = LinkMovementMethod.getInstance()
                holder.time.text = msg.createdAt?.let { formatTimeForDisplay(it) } ?: ""
                holder.time.visibility = View.GONE
                holder.text.setOnClickListener {
                    holder.time.visibility =
                        if (holder.time.visibility == View.VISIBLE) View.GONE else View.VISIBLE
                }
                val uri = AvatarManager.getAgentAvatarUri()
                if (uri != null) holder.avatar.setImageURI(uri)
                else holder.avatar.setImageResource(R.drawable.avatar_assistant)
            }
            is ToolHolder -> {
                markwon.setMarkdown(holder.text, msg.text)
                holder.text.movementMethod = LinkMovementMethod.getInstance()
                holder.time.text = msg.createdAt?.let { formatTimeForDisplay(it) } ?: ""
                holder.time.visibility = View.GONE
                holder.text.setOnClickListener {
                    holder.time.visibility =
                        if (holder.time.visibility == View.VISIBLE) View.GONE else View.VISIBLE
                }
                holder.avatar.setImageResource(R.drawable.ic_build) // Use a tool icon
            }
        }
    }

    override fun getItemCount(): Int = getAllMessages().size

    class UserHolder(view: View) : RecyclerView.ViewHolder(view) {
        val text: TextView = view.findViewById(R.id.message_text)
        val time: TextView = view.findViewById(R.id.message_time)
        val avatar: ImageView = view.findViewById(R.id.avatar)
    }

    class AssistantHolder(view: View) : RecyclerView.ViewHolder(view) {
        val text: TextView = view.findViewById(R.id.message_text)
        val time: TextView = view.findViewById(R.id.message_time)
        val avatar: ImageView = view.findViewById(R.id.avatar)
    }

    class ToolHolder(view: View) : RecyclerView.ViewHolder(view) {
        val text: TextView = view.findViewById(R.id.message_text)
        val time: TextView = view.findViewById(R.id.message_time)
        val avatar: ImageView = view.findViewById(R.id.avatar)
    }
    
}

