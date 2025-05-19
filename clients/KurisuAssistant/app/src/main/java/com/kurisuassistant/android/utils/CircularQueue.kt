package com.kurisuassistant.android.utils

class CircularQueue(capacity: Int) {
    private val data = FloatArray(capacity)
    private var head = 0
    private var tail = 0
    private var count = 0

    fun size(): Int {
        return ((tail - head) + data.size) % data.size;
    }

    /** Append a batch at tail */
    fun addAll(batch: List<Float>) {
        for (x in batch) {
            require(count < data.size) { "Buffer overflow" }
            data[tail] = x
            tail = (tail + 1) % data.size
            count++
        }
    }

    /** Get first n elements in O(n) */
    fun topFirst(n: Int): List<Float> {
        require(n <= count) { "Not enough elements" }
        return List(n) {i -> data[(head + i) % data.size]}
    }

    /** Drop first n elements in O(1) */
    fun dropFirst(n: Int) {
        require(n <= count) { "Not enough elements" }
        head = (head + n) % data.size
        count -= n
    }

    /** Export current contents as a List */
    fun toList(): List<Float> {
        return List(count) { i -> data[(head + i) % data.size] }
    }


}