/* Initialize LRU cache with default limit being 10 items */
function LRU(limit) {
    this.size = 0;
    (typeof limit == "number") ? this.limit = limit : this.limit = 10;
    this.map = {};
    this.head = null;
    this.tail = null;
}

LRU.prototype.lrunode = function(key, value) {
    if (typeof key != "undefined" && key !== null) {
        this.key = key;
    }
    if (typeof value != "undefined" && value !== null) {
        this.value = value;
    }
    this.prev = null;
    this.next = null;
};

LRU.prototype.setHead = function(node) {
    node.next = this.head;
    node.prev = null;
    if (this.head !== null) {
        this.head.prev = node;
    }
    this.head = node;
    if (this.tail === null) {
        this.tail = node;
    }
    this.size++;
    this.map[node.key] = node;
};

/* Change or add a new value in the cache
 * We overwrite the entry if it already exists
 */
LRU.prototype.set = function(key, value) {
    let node = new LRU.prototype.lrunode(key, value);
    if (this.map[key]) {
        this.map[key].value = node.value;
        this.remove(node.key);
    } else {
        if (this.size >= this.limit) {
            delete this.map[this.tail.key];
            this.size--;
            this.tail = this.tail.prev;
            this.tail.next = null;
        }
    }
    this.setHead(node);
};

/* Retrieve a single entry from the cache */
LRU.prototype.get = function(key) {
    if (this.map[key]) {
        let value = this.map[key].value;
        let node = new LRU.prototype.lrunode(key, value);
        this.remove(key);
        this.setHead(node);
        return value;
    } else {
        return undefined;
    }
};

/* Remove a single entry from the cache */
LRU.prototype.remove = function(key) {
    let node = this.map[key];
    if (node.prev !== null) {
        node.prev.next = node.next;
    } else {
        this.head = node.next;
    }
    if (node.next !== null) {
        node.next.prev = node.prev;
    } else {
        this.tail = node.prev;
    }
    delete this.map[key];
    this.size--;
};

/* Resets the entire cache - Argument limit is optional to be reset */
LRU.prototype.removeAll = function(limit) {
    this.size = 0;
    this.map = {};
    this.head = null;
    this.tail = null;
    if (typeof limit == "number") {
        this.limit = limit;
    }
};

/* Traverse through the cache elements using a callback function
 * Returns args [node element, element number, cache instance] for the callback function to use
 */
LRU.prototype.forEach = function(callback) {
    let node = this.head;
    let i = 0;
    while (node) {
        callback.apply(this, [node, i, this]);
        i++;
        node = node.next;
    }
};

/* Returns a JSON representation of the cache */
LRU.prototype.toJSON = function() {
    let json = [];
    let node = this.head;
    while (node) {
        json.push({
            key : node.key,
            value : node.value
        });
        node = node.next;
    }
    return json;
};

/* Returns a String representation of the cache */
LRU.prototype.toString = function() {
    let s = '';
    let node = this.head;
    while (node) {
        s += String(node.key)+':'+node.value;
        node = node.next;
        if (node) {
            s += '\n';
        }
    }
    return s;
};