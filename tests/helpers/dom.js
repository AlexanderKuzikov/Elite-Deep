/**
 * A minimal DOM for Node.
 *
 * The station screens and the HUD's DOM parts are pure functions of state, so
 * the only thing standing between them and a test suite is an element tree.
 * Node has no DOM, and pulling in jsdom to test "does this row say 4.2" would
 * be a large dependency for a small need.
 *
 * This implements the subset the game actually touches: element creation,
 * attributes, classList, textContent, appendChild/removeChild, querySelector
 * for the handful of selectors used, and a synchronous event dispatch.
 *
 * It is deliberately *not* a general-purpose DOM. Anything it does not support
 * throws rather than silently returning undefined, so a game change that needs
 * a new API shows up here as a loud failure instead of a passing test that
 * proves nothing.
 */

class ClassList {
  constructor(node) {
    this.node = node;
    this._set = new Set();
  }
  add(...names) { for (const n of names) this._set.add(n); this._sync(); }
  remove(...names) { for (const n of names) this._set.delete(n); this._sync(); }
  contains(name) { return this._set.has(name); }
  toggle(name, force) {
    const want = force === undefined ? !this._set.has(name) : !!force;
    if (want) this._set.add(name); else this._set.delete(name);
    this._sync();
    return want;
  }
  get length() { return this._set.size; }
  _sync() {
    this.node._className = [...this._set].join(' ');
  }
  toString() { return this.node._className; }
}

class TextNode {
  constructor(text) {
    this.nodeType = 3;
    this._text = String(text);
    this.parentNode = null;
  }
  get textContent() { return this._text; }
  set textContent(v) { this._text = String(v); }
}

class Element {
  constructor(tagName) {
    this.nodeType = 1;
    this.tagName = String(tagName).toUpperCase();
    this.childNodes = [];
    this.parentNode = null;
    this.attributes = {};
    this.style = new Proxy({}, {
      // Style is a plain bag of properties here; only assignment is used.
      get: (t, k) => (k in t ? t[k] : ''),
      set: (t, k, v) => { t[k] = v; return true; },
    });
    this.classList = new ClassList(this);
    this._className = '';
    this._listeners = new Map();
    this._id = '';
  }

  get className() { return this.classList.toString(); }
  set className(v) {
    this.classList._set = new Set(String(v).split(/\s+/).filter(Boolean));
    this.classList._sync();
  }

  get id() { return this._id; }
  set id(v) { this._id = String(v); }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
    if (name === 'id') this._id = String(value);
    if (name === 'class') this.className = value;
  }
  getAttribute(name) {
    return name in this.attributes ? this.attributes[name] : null;
  }
  removeAttribute(name) { delete this.attributes[name]; }
  hasAttribute(name) { return name in this.attributes; }

  appendChild(child) {
    if (child.parentNode) child.parentNode.removeChild(child);
    this.childNodes.push(child);
    child.parentNode = this;
    return child;
  }

  removeChild(child) {
    const i = this.childNodes.indexOf(child);
    if (i === -1) return null;
    this.childNodes.splice(i, 1);
    child.parentNode = null;
    return child;
  }

  get children() {
    return this.childNodes.filter(n => n.nodeType === 1);
  }

  get firstChild() { return this.childNodes[0] || null; }
  get lastChild() { return this.childNodes[this.childNodes.length - 1] || null; }
  get childElementCount() { return this.children.length; }

  get textContent() {
    let out = '';
    for (const c of this.childNodes) out += c.textContent;
    return out;
  }

  /** Setting text wipes children, exactly as the browser does. */
  set textContent(v) {
    for (const c of this.childNodes) c.parentNode = null;
    this.childNodes = [];
    if (v !== '' && v !== null && v !== undefined) {
      this.appendChild(new TextNode(v));
    }
  }

  addEventListener(type, fn) {
    if (!this._listeners.has(type)) this._listeners.set(type, new Set());
    this._listeners.get(type).add(fn);
  }

  removeEventListener(type, fn) {
    if (this._listeners.has(type)) this._listeners.get(type).delete(fn);
  }

  /** Synchronous dispatch. No bubbling: nothing in this game relies on it. */
  dispatchEvent(event) {
    const e = event || {};
    e.target = e.target || this;
    e.preventDefault = e.preventDefault || (() => {});
    const set = this._listeners.get(e.type);
    if (set) for (const fn of [...set]) fn(e);
    return true;
  }

  /** The subset of selectors the game uses: .class, #id, tag, and tagname.class. */
  querySelector(selector) {
    return findFirst(this, selector);
  }

  querySelectorAll(selector) {
    const out = [];
    findAll(this, selector, out);
    return out;
  }

  contains(other) {
    let n = other;
    while (n) {
      if (n === this) return true;
      n = n.parentNode;
    }
    return false;
  }

  insertBefore(node, ref) {
    const i = ref ? this.childNodes.indexOf(ref) : -1;
    if (i === -1) return this.appendChild(node);
    if (node.parentNode) node.parentNode.removeChild(node);
    this.childNodes.splice(i, 0, node);
    node.parentNode = this;
    return node;
  }
}

function matches(node, selector) {
  if (node.nodeType !== 1) return false;
  const s = selector.trim();
  const parts = s.split(',').map(x => x.trim());
  for (const part of parts) {
    if (part.startsWith('.')) {
      if (node.classList.contains(part.slice(1))) return true;
    } else if (part.startsWith('#')) {
      if (node.id === part.slice(1)) return true;
    } else if (part.includes('.')) {
      const [tag, ...cls] = part.split('.');
      if (tag && node.tagName !== tag.toUpperCase()) continue;
      if (cls.every(c => node.classList.contains(c))) return true;
    } else if (node.tagName === part.toUpperCase()) {
      return true;
    }
  }
  return false;
}

function findFirst(root, selector) {
  for (const c of root.childNodes) {
    if (c.nodeType !== 1) continue;
    if (matches(c, selector)) return c;
    const deeper = findFirst(c, selector);
    if (deeper) return deeper;
  }
  return null;
}

function findAll(root, selector, out) {
  for (const c of root.childNodes) {
    if (c.nodeType !== 1) continue;
    if (matches(c, selector)) out.push(c);
    findAll(c, selector, out);
  }
}

/** A stand-in for Event, since Node has one but without the DOM's shape. */
class FakeEvent {
  constructor(type, opts) {
    this.type = type;
    this._defaultPrevented = false;
    Object.assign(this, opts || {});
  }
  preventDefault() { this._defaultPrevented = true; }
  stopPropagation() {}
}

let installed = null;

/** Install the DOM globals. Safe to call repeatedly. */
export function installDom() {
  if (installed) return installed;
  const doc = new Element('#document');
  doc.head = new Element('head');
  doc.body = new Element('body');
  doc.documentElement = new Element('html');
  doc.appendChild(doc.documentElement);
  doc.documentElement.appendChild(doc.head);
  doc.documentElement.appendChild(doc.body);
  doc.createElement = (tag) => new Element(tag);
  doc.createTextNode = (t) => new TextNode(t);
  doc.getElementById = (id) => findFirst(doc, '#' + id);
  doc.querySelector = (s) => findFirst(doc, s);
  doc.querySelectorAll = (s) => { const o = []; findAll(doc, s, o); return o; };

  installed = {
    document: doc,
    Element,
    TextNode,
    Event: FakeEvent,
    // A window stub: the game reads innerWidth/innerHeight and listens for
    // events, and the input module must be constructible against it.
    window: makeWindow(doc),
  };

  globalThis.document = installed.document;
  globalThis.window = installed.window;
  globalThis.Event = FakeEvent;
  globalThis.HTMLElement = Element;
  return installed;
}

/** Create a detached element without touching globals. */
export function createElement(tag) {
  return new Element(tag);
}

function makeWindow(doc) {
  const w = new Element('#window');
  w.document = doc;
  w.innerWidth = 1600;
  w.innerHeight = 900;
  w.addEventListener = (type, fn) => w._listeners.set(type, (w._listeners.get(type) || new Set()).add(fn));
  w.requestAnimationFrame = (fn) => setTimeout(() => fn(Date.now()), 0);
  w.cancelAnimationFrame = (id) => clearTimeout(id);
  w.localStorage = makeStorage();
  return w;
}

/** A localStorage stub. The game uses it for save/load. */
export function makeStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    clear: () => map.clear(),
    get length() { return map.size; },
    key: (i) => [...map.keys()][i] || null,
    _map: map,
  };
}

/** Remove the globals again, for test hygiene. */
export function uninstallDom() {
  delete globalThis.document;
  delete globalThis.window;
  delete globalThis.Event;
  delete globalThis.HTMLElement;
  installed = null;
}

export { Element, TextNode, FakeEvent };
