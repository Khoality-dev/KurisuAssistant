package com.kurisuassistant.android

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.ImageView
import android.widget.TextView
import androidx.recyclerview.widget.RecyclerView
import io.noties.markwon.Markwon
import com.kurisuassistant.android.model.ChatMessage

/**
 * RecyclerView adapter displaying chat messages.
 */
class ChatAdapter(
    private val context: Context,
    private var messages: List<ChatMessage>,
) : RecyclerView.Adapter<RecyclerView.ViewHolder>() {
    
    init {
        instance = this
    }

    companion object {
        private const val USER = 0
        private const val ASSISTANT = 1
        private var instance: ChatAdapter? = null
        
        fun showTemporarySTT(text: String) {
            instance?.showTemporaryMessage(text, 3000)
        }
    }

    private var responding = false
    private var ellipsis = ""
    private val markwon = Markwon.create(context)
    private val handler = Handler(Looper.getMainLooper())
    private var tempMessage: ChatMessage? = null
    private val tempMessages = mutableListOf<ChatMessage>()
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

    fun update(newMessages: List<ChatMessage>) {
        messages = newMessages
        notifyDataSetChanged()
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
        return messages + tempMessages
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

    override fun getItemViewType(position: Int): Int = if (getAllMessages()[position].isUser) USER else ASSISTANT

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): RecyclerView.ViewHolder {
        val inflater = LayoutInflater.from(parent.context)
        return if (viewType == USER) {
            val view = inflater.inflate(R.layout.item_user_message, parent, false)
            UserHolder(view)
        } else {
            val view = inflater.inflate(R.layout.item_assistant_message, parent, false)
            AssistantHolder(view)
        }
    }

    override fun onBindViewHolder(holder: RecyclerView.ViewHolder, position: Int) {
        val allMessages = getAllMessages()
        val msg = allMessages[position]
        when (holder) {
            is UserHolder -> {
                val displayText = msg.text
                markwon.setMarkdown(holder.text, displayText)
                holder.time.text = msg.createdAt ?: ""
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
                var text = msg.displayText
                if (responding && position == allMessages.lastIndex) {
                    text += ellipsis
                }
                markwon.setMarkdown(holder.text, text)
                holder.time.text = msg.createdAt ?: ""
                holder.time.visibility = View.GONE
                holder.text.setOnClickListener {
                    holder.time.visibility =
                        if (holder.time.visibility == View.VISIBLE) View.GONE else View.VISIBLE
                }
                val uri = AvatarManager.getAgentAvatarUri()
                if (uri != null) holder.avatar.setImageURI(uri)
                else holder.avatar.setImageResource(R.drawable.avatar_assistant)
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
}

