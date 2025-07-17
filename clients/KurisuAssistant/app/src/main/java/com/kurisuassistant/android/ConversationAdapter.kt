package com.kurisuassistant.android

import android.content.Context
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.BaseAdapter
import android.widget.ImageButton
import android.widget.TextView
import android.widget.Toast

class ConversationAdapter(
    private val context: Context,
    private var conversations: List<String>,
    private val onItemClick: (position: Int) -> Unit,
    private val onItemDelete: (position: Int) -> Unit
) : BaseAdapter() {

    private var selectedPosition: Int = -1
    private var activeConversationIndex: Int = -1
    private var indexMapping: List<Int> = emptyList()

    override fun getCount(): Int = conversations.size

    override fun getItem(position: Int): Any = conversations[position]

    override fun getItemId(position: Int): Long = position.toLong()

    override fun getView(position: Int, convertView: View?, parent: ViewGroup?): View {
        val view = convertView ?: LayoutInflater.from(context).inflate(R.layout.item_conversation, parent, false)
        
        val titleText = view.findViewById<TextView>(R.id.textConversationTitle)
        val deleteButton = view.findViewById<ImageButton>(R.id.buttonDeleteConversation)
        
        titleText.text = conversations[position]
        
        // Show/hide delete button based on selection
        deleteButton.visibility = if (selectedPosition == position) View.VISIBLE else View.GONE
        
        // Highlight active conversation
        if (activeConversationIndex == position) {
            view.setBackgroundColor(context.getColor(android.R.color.holo_blue_light))
        } else {
            view.background = null
            val attrs = intArrayOf(android.R.attr.selectableItemBackground)
            val ta = context.obtainStyledAttributes(attrs)
            val drawable = ta.getDrawable(0)
            ta.recycle()
            view.background = drawable
        }
        
        // Handle regular click
        view.setOnClickListener {
            if (selectedPosition == position) {
                // If already selected, deselect and trigger conversation switch
                selectedPosition = -1
                notifyDataSetChanged()
                // Use mapped index if available, otherwise use position
                val actualIndex = if (indexMapping.isNotEmpty() && position < indexMapping.size) {
                    indexMapping[position]
                } else {
                    ChatHistory.indexFromNewest(position)
                }
                onItemClick(actualIndex)
            } else {
                // Select this item
                selectedPosition = position
                notifyDataSetChanged()
                // Use mapped index if available, otherwise use position
                val actualIndex = if (indexMapping.isNotEmpty() && position < indexMapping.size) {
                    indexMapping[position]
                } else {
                    ChatHistory.indexFromNewest(position)
                }
                onItemClick(actualIndex)
            }
        }
        
        // Handle long press to show delete button
        view.setOnLongClickListener {
            selectedPosition = if (selectedPosition == position) -1 else position
            notifyDataSetChanged()
            true
        }
        
        // Handle delete button click
        deleteButton.setOnClickListener {
            // Use mapped index if available, otherwise use position
            val actualIndex = if (indexMapping.isNotEmpty() && position < indexMapping.size) {
                indexMapping[position]
            } else {
                ChatHistory.indexFromNewest(position)
            }
            onItemDelete(actualIndex)
        }
        
        return view
    }
    
    fun updateConversations(newConversations: List<String>, newIndexMapping: List<Int> = emptyList()) {
        conversations = newConversations
        indexMapping = newIndexMapping
        selectedPosition = -1 // Reset selection when updating
        println("ConversationAdapter: Updated with ${newConversations.size} conversations")
        notifyDataSetChanged()
    }
    
    fun setActiveConversation(index: Int) {
        activeConversationIndex = index
        notifyDataSetChanged()
    }
    
    fun clearSelection() {
        selectedPosition = -1
        notifyDataSetChanged()
    }
}