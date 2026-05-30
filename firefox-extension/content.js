/**
 * MCP Browser Bridge - Content Script
 * 运行在每个页面中，负责提取 DOM 信息和执行操作
 */

(function () {
  if (window.__mcpBridgeInjected) return;
  window.__mcpBridgeInjected = true;

  // ========== 工具函数 ==========

  /** 提取页面可见文本（高效版：避免克隆整个 body） */
  function getPageText() {
    const body = document.body;
    if (!body) return '';

    // 使用 TreeWalker 直接遍历文本节点（比 cloneNode 快 10-50 倍）
    const textParts = [];
    const walker = document.createTreeWalker(
      body,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode: (node) => {
          // 跳过隐藏元素的文本
          let el = node.parentElement;
          while (el) {
            const style = window.getComputedStyle(el);
            if (style.display === 'none' || style.visibility === 'hidden') {
              return NodeFilter.FILTER_REJECT;
            }
            el = el.parentElement;
          }
          // 跳过脚本/样式内容
          const tag = node.parentElement?.tagName?.toLowerCase();
          if (['script', 'style', 'noscript', 'svg', 'canvas'].includes(tag)) {
            return NodeFilter.FILTER_REJECT;
          }
          return NodeFilter.FILTER_ACCEPT;
        }
      },
      false
    );

    let node;
    while ((node = walker.nextNode())) {
      const text = node.textContent.trim();
      if (text) {
        textParts.push(text);
      }
    }
    return textParts.join('\n');
  }

  /** 获取页面结构化信息 */
  function getPageStructure() {
    const headings = [];
    document.querySelectorAll('h1, h2, h3, h4, h5, h6').forEach(h => {
      headings.push({
        level: parseInt(h.tagName[1]),
        text: h.textContent.trim().slice(0, 200),
        id: h.id || '',
      });
    });

    const paragraphs = [];
    document.querySelectorAll('p').forEach(p => {
      const text = p.textContent.trim();
      if (text.length > 10) {
        paragraphs.push(text.slice(0, 500));
      }
    });

    return {
      title: document.title,
      url: window.location.href,
      headings,
      paragraphCount: paragraphs.length,
      textLength: document.body?.innerText?.length || 0,
      links: document.querySelectorAll('a').length,
      images: document.querySelectorAll('img').length,
    };
  }

  /** 获取页面中所有链接 */
  function getLinks() {
    const links = [];
    const seen = new Set();
    document.querySelectorAll('a[href]').forEach(a => {
      const href = a.href;
      if (!href || href.startsWith('javascript:') || seen.has(href)) return;
      seen.add(href);
      links.push({
        url: href,
        text: a.textContent.trim().slice(0, 200) || '[image]',
        title: a.title || '',
        rel: a.rel || '',
      });
    });
    return links.slice(0, 500); // 限制数量
  }

  /** 获取选中文本 */
  function getSelection() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) return null;
    return {
      text: sel.toString().slice(0, 5000),
      html: sel.rangeCount > 0 ? sel.getRangeAt(0).toString() : '',
    };
  }

  /** 获取 meta 信息 */
  function getMeta() {
    const meta = {};
    document.querySelectorAll('meta').forEach(m => {
      const name = m.getAttribute('name') || m.getAttribute('property') || '';
      const content = m.getAttribute('content') || '';
      if (name && content) meta[name] = content.slice(0, 500);
    });
    return meta;
  }

  /** 查找元素 */
  function findElement(selector) {
    try {
      return document.querySelector(selector);
    } catch (e) {
      return null;
    }
  }

  /** 获取可见的 interactive 元素列表（批量性能优化版） */
  function getInteractiveElements() {
    const elements = [];
    const selectors = [
      'a[href]', 'button', 'input:not([type=hidden])', 'select',
      'textarea', '[role=button]', '[role=link]', '[role=tab]',
      '[role=menuitem]', '[onclick]', '.btn', '[tabindex]:not([tabindex="-1"])',
    ];
    const selector = selectors.join(',');

    // 批量获取所有元素 + 强制批量布局（一次重排）
    const allElements = [...document.querySelectorAll(selector)];
    // 用 getClientRects 批量读取布局信息（触发一次 layout）
    const viewH = window.innerHeight;
    const viewW = window.innerWidth;

    allElements.forEach(el => {
      const rect = el.getBoundingClientRect();
      // 快速可见性过滤
      if (rect.width === 0 || rect.height === 0) return;
      if (rect.top > viewH || rect.bottom < 0) return;
      if (rect.left > viewW || rect.right < 0) return;

      const tag = el.tagName.toLowerCase();
      const type = el.type || '';
      const text = (el.textContent || '').trim().slice(0, 100);
      const href = el.href || '';
      const placeholder = el.placeholder || '';
      const ariaLabel = el.getAttribute('aria-label') || '';
      const name = el.getAttribute('name') || '';
      const id = el.id || '';

      elements.push({
        tag,
        type,
        text,
        href,
        placeholder,
        ariaLabel,
        name,
        id,
        rect: {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          centerX: Math.round(rect.x + rect.width / 2),
          centerY: Math.round(rect.y + rect.height / 2),
        },
        selector: generateSelector(el),
        tabIndex: el.tabIndex,
        disabled: el.disabled || false,
        checked: el.checked || false,
        value: el.value || '',
      });
    });
    return elements;
  }

  /** 生成元素的 CSS 选择器 */
  function generateSelector(el) {
    if (el.id) return `#${CSS.escape(el.id)}`;
    if (el.getAttribute('name') && el.form) {
      return `[name="${CSS.escape(el.getAttribute('name'))}"]`;
    }

    const path = [];
    let current = el;
    while (current && current !== document.body && current !== document.documentElement) {
      let selector = current.tagName.toLowerCase();
      if (current.id) {
        path.unshift(`#${CSS.escape(current.id)}`);
        break;
      }
      if (current.className && typeof current.className === 'string') {
        const classes = current.className.trim().split(/\s+/).filter(c => c.length > 0 && !c.startsWith('_'));
        if (classes.length > 0 && classes.length <= 3) {
          selector += '.' + classes.map(c => CSS.escape(c)).join('.');
        }
      }
      // 添加 nth-child 来保证唯一性
      const parent = current.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter(
          s => s.tagName === current.tagName
        );
        if (siblings.length > 1) {
          const idx = siblings.indexOf(current) + 1;
          selector += `:nth-child(${idx})`;
        }
      }
      path.unshift(selector);
      current = current.parentElement;
    }
    return path.join(' > ');
  }

  /** 搜索页面文本 */
  function searchText(query) {
    const results = [];
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
      null,
      false
    );
    let node;
    const lowerQuery = query.toLowerCase();
    while ((node = walker.nextNode()) && results.length < 100) {
      const text = node.textContent;
      if (text && text.toLowerCase().includes(lowerQuery)) {
        const parent = node.parentElement;
        const rect = parent ? parent.getBoundingClientRect() : null;
        const idx = text.toLowerCase().indexOf(lowerQuery);
        results.push({
          context: text.slice(Math.max(0, idx - 60), idx + query.length + 60).trim(),
          tag: parent?.tagName || '',
          selector: parent ? generateSelector(parent) : '',
          rect: rect ? {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          } : null,
        });
      }
    }
    return results;
  }

  /** 获取表单字段 */
  function getForms() {
    const forms = [];
    document.querySelectorAll('form').forEach((form, fi) => {
      const fields = [];
      form.querySelectorAll('input, select, textarea').forEach(el => {
        fields.push({
          tag: el.tagName.toLowerCase(),
          type: el.type || '',
          name: el.name || '',
          id: el.id || '',
          placeholder: el.placeholder || '',
          value: el.value || '',
          required: el.required || false,
          disabled: el.disabled || false,
          selector: generateSelector(el),
          options: el.tagName === 'SELECT' ?
            Array.from(el.options).map(o => ({ value: o.value, text: o.text })) : undefined,
        });
      });
      if (fields.length > 0) {
        forms.push({
          index: fi,
          id: form.id || '',
          name: form.name || '',
          action: form.action || '',
          method: form.method || 'get',
          fields,
          selector: generateSelector(form),
        });
      }
    });
    return forms;
  }

  /** 获取图片信息 */
  function getImages() {
    const images = [];
    document.querySelectorAll('img[src]').forEach(img => {
      const rect = img.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      images.push({
        src: img.src,
        alt: img.alt || '',
        width: img.naturalWidth || rect.width,
        height: img.naturalHeight || rect.height,
        rect: {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        },
      });
    });
    return images.slice(0, 100);
  }

  /** 高亮元素 */
  function highlightElement(selector, color) {
    const el = findElement(selector);
    if (!el) return { found: false };
    const originalOutline = el.style.outline;
    const originalBg = el.style.backgroundColor;
    el.style.outline = `3px solid ${color || '#ff5722'}`;
    el.style.backgroundColor = 'rgba(255, 87, 34, 0.1)';
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setTimeout(() => {
      el.style.outline = originalOutline;
      el.style.backgroundColor = originalBg;
    }, 2000);
    const rect = el.getBoundingClientRect();
    return {
      found: true,
      tag: el.tagName,
      text: (el.textContent || '').trim().slice(0, 200),
      rect: {
        x: Math.round(rect.x), y: Math.round(rect.y),
        width: Math.round(rect.width), height: Math.round(rect.height),
      },
    };
  }

  /** 简化 DOM 树 */
  function getSimplifiedDOM(maxDepth = 5) {
    function walk(node, depth) {
      if (depth > maxDepth) return null;
      if (node.nodeType === Node.TEXT_NODE) {
        const text = node.textContent.trim();
        if (!text) return null;
        return { type: 'text', text: text.slice(0, 200) };
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return null;

      const el = node;
      const tag = el.tagName.toLowerCase();

      // 忽略不可见/无用元素
      if (['script', 'style', 'noscript', 'meta', 'link'].includes(tag)) return null;

      const rect = el.getBoundingClientRect();
      const isVisible = rect.width > 0 && rect.height > 0;
      const isOffscreen = rect.bottom < 0 || rect.top > window.innerHeight;

      const entry = {
        tag,
        id: el.id || undefined,
        classes: el.className && typeof el.className === 'string' ?
          el.className.trim().split(/\s+/).filter(Boolean).slice(0, 3) : undefined,
        visible: isVisible && !isOffscreen,
        rect: isVisible ? {
          x: Math.round(rect.x), y: Math.round(rect.y),
          w: Math.round(rect.width), h: Math.round(rect.height),
        } : undefined,
      };

      // 添加有意义的信息
      if (el.textContent && ['h1','h2','h3','h4','h5','h6','a','button','th','strong','b','em','i','label','caption'].includes(tag)) {
        entry.text = el.textContent.trim().slice(0, 200);
      }
      if (tag === 'a' && el.href) entry.href = el.href;
      if (tag === 'img') entry.src = el.src, entry.alt = el.alt;
      if (el.placeholder) entry.placeholder = el.placeholder;
      if (el.type) entry.type = el.type;
      if (el.name) entry.name = el.name;
      if (el.value && tag !== 'input') entry.value = el.value;

      // 递归子节点
      const children = [];
      for (const child of el.children) {
        const result = walk(child, depth + 1);
        if (result) children.push(result);
      }
      if (children.length > 0) {
        // 如果子节点太多，限制数量
        entry.children = children.length <= 50 ? children : children.slice(0, 50);
      }

      return entry;
    }

    return walk(document.body, 0);
  }

  /** 获取当前滚动位置和页面尺寸 */
  function getScrollInfo() {
    return {
      scrollX: Math.round(window.scrollX),
      scrollY: Math.round(window.scrollY),
      scrollWidth: Math.round(document.documentElement.scrollWidth || document.body.scrollWidth),
      scrollHeight: Math.round(document.documentElement.scrollHeight || document.body.scrollHeight),
      innerWidth: Math.round(window.innerWidth),
      innerHeight: Math.round(window.innerHeight),
    };
  }

  /** 获取 localStorage */
  function getLocalStorage(keys) {
    if (keys && keys.length > 0) {
      const result = {};
      keys.forEach(k => { try { result[k] = localStorage.getItem(k); } catch(e) {} });
      return result;
    }
    // 返回所有
    const result = {};
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        result[key] = localStorage.getItem(key);
      }
    } catch(e) {}
    return result;
  }

  /** 获取 cookies (document.cookie) */
  function getDocumentCookies() {
    return document.cookie || '';
  }

  /** 全 DOM 树 DFS 遍历，返回所有可点击元素的稳定索引列表（独立函数，供 action 和 clickByDOMIndex 共用） */
  function getDOMClickableElements() {
    const elements = [];
    let index = 0;

    function isClickable(el) {
      const tag = el.tagName.toLowerCase();
      const type = el.type || '';
      const role = el.getAttribute('role') || '';
      const tabIndex = el.tabIndex;
      const hasOnClick = el.hasAttribute('onclick');

      // CSS 隐藏检测：display:none 或 visibility:hidden 不可交互
      const cs = window.getComputedStyle(el);
      if (cs.display === 'none') return false;

      if (tag === 'a' && el.href && el.href !== '#') return true;
      if (tag === 'button') return true;
      if (tag === 'select') return true;
      if (tag === 'textarea') return true;
      if (tag === 'input' && type !== 'hidden') return true;
      const roles = ['button','link','tab','menuitem','checkbox','radio','switch','option','menuitemcheckbox','menuitemradio','combobox','listbox'];
      if (roles.includes(role)) return true;
      if (hasOnClick && tag !== 'body' && tag !== 'html') return true;
      if (tabIndex >= 0 && tabIndex < 32768) return true;
      if (el.classList.contains('btn') || el.classList.contains('button')) return true;
      if (el.getAttribute('ng-click') || el.getAttribute('@click') || el.getAttribute('v-on:click')) return true;
      return false;
    }

    function dfs(node, depth) {
      if (!node || node.nodeType !== Node.ELEMENT_NODE) return;
      const tag = node.tagName.toLowerCase();
      if (['script','style','noscript','meta','link','head','svg','path','use','g','circle','rect','defs','clipPath','mask','pattern'].includes(tag)) return;

      if (isClickable(node)) {
        const rect = node.getBoundingClientRect();
        const viewH = window.innerHeight;
        const viewW = window.innerWidth;
        const nodeCS = window.getComputedStyle(node);
        elements.push({
          index,
          tag,
          type: node.type || '',
          text: (node.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 120),
          href: node.href || '',
          placeholder: node.placeholder || '',
          ariaLabel: node.getAttribute('aria-label') || '',
          name: node.getAttribute('name') || '',
          id: node.id || '',
          depth,
          selector: generateSelector(node),
          rect: {
            x: Math.round(rect.x), y: Math.round(rect.y),
            width: Math.round(rect.width), height: Math.round(rect.height),
            centerX: Math.round(rect.x + rect.width / 2),
            centerY: Math.round(rect.y + rect.height / 2),
          },
          isVisible: rect.width > 0 && rect.height > 0,
          isInViewport: rect.bottom >= 0 && rect.top <= viewH && rect.right >= 0 && rect.left <= viewW,
          display: nodeCS.display,
          disabled: node.disabled || false,
          value: node.value || '',
        });
        index++;
      }

      // 跳过 iframe（跨域无法访问）
      if (tag === 'iframe') return;
      for (const child of node.children) {
        dfs(child, depth + 1);
      }
      // shadow DOM
      if (node.shadowRoot) {
        for (const child of node.shadowRoot.children) {
          dfs(child, depth + 1);
        }
      }
    }

    dfs(document.body, 0);
    return { elements: elements.slice(0, 500), total: index };
  }

  // ========== 命令分发器 ==========

  const actions = {
    getPageText: () => ({ text: getPageText().slice(0, 50000) }),
    getPageStructure: () => getPageStructure(),
    getLinks: () => ({ links: getLinks() }),
    getSelection: () => getSelection(),
    getMeta: () => ({ meta: getMeta() }),
    getInteractiveElements: () => ({ elements: getInteractiveElements() }),
    searchText: (p) => ({ results: searchText(p.query || p.text || '') }),
    getForms: () => ({ forms: getForms() }),
    getImages: () => ({ images: getImages() }),
    highlight: (p) => highlightElement(p.selector, p.color),
    getDOM: (p) => getSimplifiedDOM(p.maxDepth || 5),
    getScrollInfo: () => getScrollInfo(),

    // 页面操作
    navigate: (p) => {
      window.location.href = p.url;
      return { success: true, url: p.url };
    },
    click: (p) => {
      const el = findElement(p.selector);
      if (!el) throw new Error(`Element not found: ${p.selector}`);
      el.click();
      return { success: true, tag: el.tagName, text: (el.textContent || '').trim().slice(0, 200) };
    },
    clickByIndex: (p) => {
      const elements = getInteractiveElements();
      const el = elements[p.index];
      if (!el) throw new Error(`Interactive element #${p.index} not found`);
      const domEl = findElement(el.selector);
      if (!domEl) throw new Error(`Element not found: ${el.selector}`);
      domEl.click();
      return { success: true, element: el };
    },
    scrollBy: (p) => {
      window.scrollBy({
        top: p.y || p.amount || 300,
        left: p.x || 0,
        behavior: p.smooth !== false ? 'smooth' : 'auto',
      });
      return getScrollInfo();
    },
    scrollTo: (p) => {
      window.scrollTo({
        top: p.y || 0,
        left: p.x || 0,
        behavior: p.smooth !== false ? 'smooth' : 'auto',
      });
      return getScrollInfo();
    },
    scrollIntoView: (p) => {
      const el = findElement(p.selector);
      if (!el) throw new Error(`Element not found: ${p.selector}`);
      el.scrollIntoView({ behavior: 'smooth', block: p.block || 'center' });
      return { success: true };
    },
    fillField: (p) => {
      const el = findElement(p.selector);
      if (!el) throw new Error(`Element not found: ${p.selector}`);
      el.value = p.value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { success: true, value: p.value };
    },
    selectOption: (p) => {
      const el = findElement(p.selector);
      if (!el) throw new Error(`Select element not found: ${p.selector}`);
      if (el.tagName !== 'SELECT') throw new Error('Element is not a SELECT');
      el.value = p.value;
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { success: true, selectedValue: el.value };
    },
    executeJS: (p) => {
      const result = (0, eval)(p.code);
      return { result: String(result).slice(0, 10000) };
    },
    getLocalStorage: (p) => ({ data: getLocalStorage(p.keys) }),
    getCookies: () => ({ cookies: getDocumentCookies() }),
    getVisibleText: () => {
      // 使用 TreeWalker 高效获取视口内可见文本
      const viewportTexts = [];
      const walker = document.createTreeWalker(
        document.body,
        NodeFilter.SHOW_TEXT,
        {
          acceptNode: (node) => {
            const range = document.createRange();
            range.selectNode(node);
            const rect = range.getBoundingClientRect();
            range.detach();
            if (rect.width === 0 && rect.height === 0) return NodeFilter.FILTER_REJECT;
            if (rect.bottom < -10 || rect.top > window.innerHeight + 10) return NodeFilter.FILTER_REJECT;
            if (rect.right < -10 || rect.left > window.innerWidth + 10) return NodeFilter.FILTER_REJECT;
            // 跳过隐藏元素
            let el = node.parentElement;
            while (el) {
              const style = window.getComputedStyle(el);
              if (style.display === 'none' || style.visibility === 'hidden') return NodeFilter.FILTER_REJECT;
              el = el.parentElement;
            }
            return NodeFilter.FILTER_ACCEPT;
          }
        },
        false
      );
      let node;
      while ((node = walker.nextNode())) {
        const text = node.textContent.trim();
        if (text.length > 3) viewportTexts.push(text);
      }
      return { text: viewportTexts.join('\n').slice(0, 30000) };
    },
    getUrl: () => ({ url: window.location.href, title: document.title }),
    ping: () => ({ pong: true, url: window.location.href }),

    // ===== 新功能 V1.2 =====

    /** 悬停到元素上（触发 mouseover/mouseenter 事件） */
    hover: (p) => {
      const el = findElement(p.selector);
      if (!el) throw new Error(`Element not found: ${p.selector}`);
      el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true }));
      el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true, cancelable: true }));
      el.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, cancelable: true }));
      return {
        success: true,
        tag: el.tagName,
        text: (el.textContent || '').trim().slice(0, 200),
      };
    },

    /** 按可见文本内容查找并点击元素 */
    clickByText: (p) => {
      const text = (p.text || '').toLowerCase().trim();
      if (!text) throw new Error('clickByText requires a text parameter');
      // 在所有可交互元素中搜索匹配文本
      const allInteractive = document.querySelectorAll(
        'a[href], button, input[type=submit], input[type=button], ' +
        '[role=button], [role=link], [role=tab], [role=menuitem], ' +
        '[onclick], .btn, [tabindex]:not([tabindex="-1"])'
      );
      // 精确匹配优先，然后是包含匹配
      let bestMatch = null;
      let bestScore = -1;
      allInteractive.forEach(el => {
        const elText = (el.textContent || el.value || el.getAttribute('aria-label') || '').trim().toLowerCase();
        if (elText === text) {
          bestMatch = el;
          bestScore = 100;
          return; // 精确匹配，直接胜出
        }
        if (elText.includes(text) && text.length > 2) {
          // 包含匹配，按匹配长度比例评分
          const score = text.length / elText.length;
          if (score > bestScore) {
            bestScore = score;
            bestMatch = el;
          }
        }
      });
      if (!bestMatch) {
        // 回退：在全 DOM 搜索文本节点
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
        let node;
        while ((node = walker.nextNode())) {
          const nodeText = node.textContent.trim().toLowerCase();
          if (nodeText === text || nodeText.includes(text)) {
            const parent = node.parentElement;
            if (parent && parent.closest('a, button, [role=button], [role=link], [tabindex]')) {
              bestMatch = parent.closest('a, button, [role=button], [role=link], [tabindex]');
              break;
            }
          }
        }
      }
      if (!bestMatch) throw new Error(`No clickable element found with text: "${p.text}"`);
      bestMatch.click();
      return {
        success: true,
        tag: bestMatch.tagName,
        text: (bestMatch.textContent || '').trim().slice(0, 200),
        selector: generateSelector(bestMatch),
      };
    },

    /** 获取元素的详细信息（属性、样式、位置、状态） */
    getElementInfo: (p) => {
      const el = findElement(p.selector);
      if (!el) throw new Error(`Element not found: ${p.selector}`);
      const rect = el.getBoundingClientRect();
      const styles = window.getComputedStyle(el);
      const tag = el.tagName.toLowerCase();
      const info = {
        tag,
        id: el.id || '',
        classes: (el.className && typeof el.className === 'string')
          ? el.className.trim().split(/\s+/).filter(Boolean) : [],
        text: (el.textContent || '').trim().slice(0, 1000),
        value: el.value || '',
        innerHTML: (tag === 'a' || tag === 'button' || tag === 'span' || tag === 'div')
          ? el.innerHTML.slice(0, 500) : undefined,
        rect: {
          x: Math.round(rect.x), y: Math.round(rect.y),
          width: Math.round(rect.width), height: Math.round(rect.height),
        },
        isVisible: rect.width > 0 && rect.height > 0,
        isInViewport: rect.bottom >= 0 && rect.top <= window.innerHeight &&
                      rect.right >= 0 && rect.left <= window.innerWidth,
        computedStyles: {
          display: styles.display,
          visibility: styles.visibility,
          opacity: styles.opacity,
          position: styles.position,
          zIndex: styles.zIndex,
          overflow: styles.overflow,
          pointerEvents: styles.pointerEvents,
          cursor: styles.cursor,
        },
        attributes: {},
        aria: {},
        selector: generateSelector(el),
        tagName: tag,
        disabled: el.disabled || false,
        readOnly: el.readOnly || false,
        required: el.required || false,
        checked: el.checked || false,
        selected: el.selected || false,
        href: el.href || '',
        src: el.src || '',
        alt: el.alt || '',
        placeholder: el.placeholder || '',
        title: el.title || '',
        ariaLabel: el.getAttribute('aria-label') || '',
        tabIndex: el.tabIndex,
        scrollIntoView: () => { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); },
      };
      // 提取关键 attributes
      ['type', 'name', 'role', 'data-*', 'href', 'target', 'rel',
       'src', 'alt', 'width', 'height', 'action', 'method',
      ].forEach(attr => {
        const val = el.getAttribute(attr);
        if (val) info.attributes[attr] = val;
      });
      return info;
    },

    /** 提取页面中所有表格为结构化数据 */
    extractTables: (p) => {
      const tables = [];
      document.querySelectorAll('table').forEach((table, idx) => {
        try {
          const rows = [];
          const headerRow = table.querySelector('thead tr') || table.querySelector('tr');
          const headers = [];
          if (headerRow) {
            headerRow.querySelectorAll('th, td').forEach(th => {
              headers.push((th.textContent || '').trim());
            });
          }
          // 数据行
          const dataRows = table.querySelectorAll('tbody tr') || table.querySelectorAll('tr');
          dataRows.forEach(tr => {
            const cells = [];
            tr.querySelectorAll('td, th').forEach(td => {
              cells.push((td.textContent || '').trim());
            });
            if (cells.length > 0) rows.push(cells);
          });
          // 没找到 tbody 时直接用 tr
          if (rows.length === 0) {
            table.querySelectorAll('tr').forEach((tr, ri) => {
              if (ri === 0 && headers.length === 0) {
                tr.querySelectorAll('th, td').forEach(th => headers.push((th.textContent || '').trim()));
                return;
              }
              const cells = [];
              tr.querySelectorAll('td, th').forEach(td => cells.push((td.textContent || '').trim()));
              if (cells.length > 0) rows.push(cells);
            });
          }
          const rect = table.getBoundingClientRect();
          tables.push({
            index: idx,
            caption: (table.querySelector('caption')?.textContent || '').trim(),
            headers,
            rowCount: rows.length,
            colCount: headers.length || (rows[0]?.length || 0),
            rows: rows.slice(0, 200), // 限制行数
            selector: generateSelector(table),
            rect: {
              x: Math.round(rect.x), y: Math.round(rect.y),
              w: Math.round(rect.width), h: Math.round(rect.height),
            },
          });
        } catch (e) {
          // 单个表格解析失败不影响其他表格
        }
      });
      return { tables, count: tables.length };
    },

    /** 注入 CSS 样式 */
    injectCSS: (p) => {
      const id = '__mcp_bridge_css_' + Date.now();
      const existing = document.getElementById(id);
      if (existing) existing.remove();
      const style = document.createElement('style');
      style.id = id;
      style.textContent = p.code || '';
      document.head.appendChild(style);
      return { success: true, id, cssLength: (p.code || '').length };
    },

    /** 隐藏元素 */
    hideElement: (p) => {
      const el = findElement(p.selector);
      if (!el) throw new Error(`Element not found: ${p.selector}`);
      const original = {
        display: el.style.display,
        visibility: el.style.visibility,
        opacity: el.style.opacity,
      };
      el.style.display = 'none';
      return { success: true, original };
    },

    /** 双击元素 */
    doubleClick: (p) => {
      const el = findElement(p.selector);
      if (!el) throw new Error(`Element not found: ${p.selector}`);
      el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
      return {
        success: true,
        tag: el.tagName,
        text: (el.textContent || '').trim().slice(0, 200),
      };
    },

    /** 设置 localStorage */
    setLocalStorage: (p) => {
      try {
        localStorage.setItem(p.key, p.value);
        return { success: true, key: p.key, valueLength: (p.value || '').length };
      } catch (e) {
        throw new Error(`localStorage setItem failed: ${e.message}`);
      }
    },

    /** 删除 localStorage 项 */
    removeLocalStorage: (p) => {
      try {
        localStorage.removeItem(p.key);
        return { success: true, key: p.key };
      } catch (e) {
        throw new Error(`localStorage removeItem failed: ${e.message}`);
      }
    },

    // ===== DOM 树索引系统（升级 browser_click_index） =====

    /** 全 DOM 树 DFS 遍历，返回所有可点击元素的稳定索引列表 */
    getDOMClickableElements: () => getDOMClickableElements(),

    /** 通过 DOM 树索引点击元素（含不可见元素降级处理） */
    clickByDOMIndex: (p) => {
      const { elements } = actions.getDOMClickableElements();
      const target = elements[p.index];
      if (!target) throw new Error(`DOM index #${p.index} not found (total: ${elements.length}, available: 0-${elements.length-1})`);
      const domEl = findElement(target.selector);
      if (!domEl) throw new Error(`Element #${p.index} not found in DOM: ${target.selector}`);

      // 可见性降级：如果元素 display:none 或 visibility:hidden，
      // scrollIntoView 不生效，需找到最近的可见祖先来滚动
      const elStyle = window.getComputedStyle(domEl);
      if (elStyle.display === 'none' || elStyle.visibility === 'hidden') {
        let parent = domEl.parentElement;
        while (parent && parent !== document.body) {
          const ps = window.getComputedStyle(parent);
          if (ps.display !== 'none' && ps.visibility !== 'hidden') {
            parent.scrollIntoView({ behavior: 'smooth', block: 'center' });
            break;
          }
          parent = parent.parentElement;
        }
      } else {
        domEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }

      domEl.click();
      return {
        success: true,
        index: p.index,
        tag: target.tag,
        text: target.text.slice(0, 200),
        selector: target.selector,
        rect: target.rect,
        wasVisible: target.isVisible,
        wasCSSHidden: elStyle.display === 'none' || elStyle.visibility === 'hidden',
      };
    },

    /** 搜索文本并滚动到该位置（scrollToText） */
    scrollToText: (p) => {
      const query = (p.text || p.query || '').trim();
      if (!query) throw new Error('scrollToText requires a text parameter');
      const lowerQuery = query.toLowerCase();

      // 1. 用 TreeWalker 查找第一个包含文本的节点
      let bestNode = null;
      let bestParent = null;
      let bestContext = '';
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
      let node;
      while ((node = walker.nextNode())) {
        const text = node.textContent;
        if (text && text.toLowerCase().includes(lowerQuery)) {
          bestNode = node;
          bestParent = node.parentElement;
          const idx = text.toLowerCase().indexOf(lowerQuery);
          bestContext = text.slice(Math.max(0, idx - 40), idx + query.length + 40).trim();
          break;
        }
      }

      if (!bestNode || !bestParent) {
        throw new Error(`Text not found on page: "${query}"`);
      }

      // 2. 找到最近的滚动目标（可滚动的祖先元素或 body）
      let scrollTarget = bestParent;
      // 尝试找到最近的标题/段落等有意义的块级元素
      let candidate = bestParent;
      while (candidate && candidate !== document.body) {
        const tag = candidate.tagName.toLowerCase();
        if (['h1','h2','h3','h4','h5','h6','p','div','section','article','li','blockquote','pre','td','th'].includes(tag)) {
          scrollTarget = candidate;
          break;
        }
        candidate = candidate.parentElement;
      }

      // 3. 滚动到目标
      scrollTarget.scrollIntoView({ behavior: 'smooth', block: 'center' });

      // 4. 高亮闪烁效果
      const origOutline = scrollTarget.style.outline;
      const origBg = scrollTarget.style.backgroundColor;
      scrollTarget.style.outline = '3px solid #ff5722';
      scrollTarget.style.backgroundColor = 'rgba(255, 87, 34, 0.08)';
      setTimeout(() => {
        scrollTarget.style.outline = origOutline;
        scrollTarget.style.backgroundColor = origBg;
      }, 2000);

      // 5. 返回位置信息
      const rect = scrollTarget.getBoundingClientRect();
      const scrollInfo = {
        scrollX: Math.round(window.scrollX),
        scrollY: Math.round(window.scrollY),
        innerHeight: Math.round(window.innerHeight),
        innerWidth: Math.round(window.innerWidth),
      };

      return {
        success: true,
        query,
        tag: scrollTarget.tagName,
        selector: generateSelector(scrollTarget),
        context: bestContext,
        rect: {
          x: Math.round(rect.x), y: Math.round(rect.y),
          width: Math.round(rect.width), height: Math.round(rect.height),
          centerY: Math.round(rect.y + rect.height / 2),
        },
        isInViewport: rect.bottom >= 0 && rect.top <= window.innerHeight &&
                      rect.right >= 0 && rect.left <= window.innerWidth,
        scroll: scrollInfo,
      };
    },
  };

  // ========== 消息监听 ==========

  browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg.action) return false;

    const action = actions[msg.action];
    if (!action) {
      if (msg.commandId) {
        // 通过 runtime.sendMessage 返回
        sendResponse({
          type: 'command_result',
          commandId: msg.commandId,
          success: false,
          error: `Unknown action: ${msg.action}`,
        });
      }
      return false;
    }

    // 执行操作
    try {
      const result = action(msg.params || {});
      if (result instanceof Promise) {
        result
          .then(data => {
            if (msg.commandId) {
              sendResponse({
                type: 'command_result',
                commandId: msg.commandId,
                success: true,
                data,
              });
            }
          })
          .catch(err => {
            if (msg.commandId) {
              sendResponse({
                type: 'command_result',
                commandId: msg.commandId,
                success: false,
                error: err.message || String(err),
              });
            }
          });
        return true; // async
      } else {
        if (msg.commandId) {
          sendResponse({
            type: 'command_result',
            commandId: msg.commandId,
            success: true,
            data: result,
          });
        }
        return false;
      }
    } catch (e) {
      if (msg.commandId) {
        sendResponse({
          type: 'command_result',
          commandId: msg.commandId,
          success: false,
          error: e.message || String(e),
        });
      }
      return false;
    }
  });

  console.log('[MCP Bridge] Content script loaded in:', window.location.href);
})();