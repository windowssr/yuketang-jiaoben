// ==UserScript==
// @name         雨课堂刷课助手
// @namespace    http://tampermonkey.net/
// @version      3.1.28
// @description  针对雨课堂视频进行自动播放，配置AI自动答题
// @author       风之子
// @license      GPL3
// @match        *://*.yuketang.cn/*
// @match        *://*.gdufemooc.cn/*
// @run-at       document-start
// @icon         http://yuketang.cn/favicon.ico
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @connect      api.openai.com
// @connect      api.moonshot.cn
// @connect      api.deepseek.com
// @connect      cn.bing.com
// @connect      www.bing.com
// @connect      dashscope.aliyuncs.com
// @connect      llm-pieg74srnbf94v24.cn-beijing.maas.aliyuncs.com
// @connect      api.anthropic.com
// @connect      *
// @connect      cdn.jsdelivr.net
// @connect      unpkg.com
// @require      https://cdn.jsdelivr.net/npm/opentype.js@1.3.4/dist/opentype.min.js
// @require      https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js
// @require      https://unpkg.com/tesseract.js@v2.1.0/dist/tesseract.min.js
// @downloadURL https://update.greasyfork.org/scripts/466651/%E9%9B%A8%E8%AF%BE%E5%A0%82%E5%88%B7%E8%AF%BE%E5%8A%A9%E6%89%8B.user.js
// @updateURL https://update.greasyfork.org/scripts/466651/%E9%9B%A8%E8%AF%BE%E5%A0%82%E5%88%B7%E8%AF%BE%E5%8A%A9%E6%89%8B.meta.js
// ==/UserScript==

(() => {
  'use strict';

  let panel; // UI 面板实例后置初始化

  // ---- 脚本配置，用户可修改 ----
  const Config = {
    version: '3.1.28',    // 版本号
    playbackRate: 1,      // 视频播放倍速。高于 1 时，雨课堂会把跳过的区间记成未观看
    pptInterval: 3000,    // ppt翻页间隔
    storageKeys: {        // 使用者勿动
      progress: '[脚本]刷课进度信息',
      ai: 'ykt_ai_conf',
      qwen: 'ykt_qwen_conf',
      proClassCount: 'pro_lms_classCount',
      feature: 'ykt_feature_conf', // 是否开启AI作答/自动评论
      pendingAutoStart: 'ykt_pending_auto_start',
      trail: 'ykt_trail'
    }
  };

  const Utils = {
    // 短暂睡眠，等待网页加载
    sleep: (ms = 1000) => new Promise(resolve => setTimeout(resolve, ms)),
    humanPause(min = 900, max = 2400) {
      const low = Math.min(min, max);
      const high = Math.max(min, max);
      const ms = low + Math.floor(Math.random() * (high - low + 1));
      return this.sleep(ms);
    },
    isHumanCheckVisible() {
      const pattern = /安全核验|按住.{0,8}起|依次经过|人机|验证码|安全验证|滑动验证|请完成验证|拖动滑块/;
      const docs = [document];
      for (const frame of document.querySelectorAll('iframe')) {
        try {
          if (frame.contentDocument?.body) docs.push(frame.contentDocument);
        } catch (_) {}
      }
      for (const doc of docs) {
        const pageText = doc.body?.innerText || '';
        if (!pattern.test(pageText)) continue;
        const nodes = doc.querySelectorAll('div, section, p, h1, h2, h3, span');
        for (const node of nodes) {
          const text = (node.innerText || '').trim();
          if (text.length < 4 || text.length > 80 || !pattern.test(text)) continue;
          const view = doc.defaultView || window;
          const style = view.getComputedStyle(node);
          const rect = node.getBoundingClientRect();
          if (style.display === 'none' || style.visibility === 'hidden' || rect.width === 0 || rect.height === 0) continue;
          return true;
        }
      }
      return false;
    },
    humanCheckMode() {
      return Store.getFeatureConf().humanCheckMode === 'wait' ? 'wait' : 'skip';
    },
    async gateHumanCheck() {
      if (!this.isHumanCheckVisible()) {
        this._humanCheckLogged = false;
        return 'ok';
      }
      if (!this._humanCheckLogged) {
        panel?.log('检测到安全核验，脚本已停下。请手动拖完后，脚本会继续当前章节');
        this._humanCheckLogged = true;
      }
      while (this.isHumanCheckVisible()) await this.sleep(1000);
      this._humanCheckLogged = false;
      panel?.log('安全核验窗口已关闭，继续当前章节');
      return 'waited';
    },
    async waitIfHumanCheck() {
      return (await this.gateHumanCheck()) !== 'skip';
    },
    async humanClick(element, min = 800, max = 2000) {
      if (!element) return;
      if (!await this.waitIfHumanCheck()) return;
      try {
        element.scrollIntoView({ behavior: 'smooth', block: 'center' });
      } catch (_) {}
      await this.humanPause(min, max);
      element.click();
    },
    // 将一个 JSON 字符串解析为 JavaScript 对象
    safeJSONParse(value, fallback) {
      try {
        return JSON.parse(value);
      } catch (_) {
        return fallback;
      }
    },
    // 每隔一段时间检查某个条件是否满足（通过 checker 函数），如果满足就成功返回；如果超时仍未满足，就失败返回
    async poll(checker, { interval = 1000, timeout = 20000 } = {}) {
      let spent = 0;
      while (spent <= timeout) {
        const gateStarted = Date.now();
        const gate = await this.gateHumanCheck();
        const gateCost = Date.now() - gateStarted;
        if (gate === 'skip') return false;
        if (checker()) return true;
        const pauseStarted = Date.now();
        await this.sleep(interval);
        const pauseCost = Date.now() - pauseStarted;
        spent += (gate === 'waited' ? 0 : gateCost) + pauseCost;
      }
      return false;
    },
    // 使用UI课程完成度来判别是否完成课程
    isProgressDone(text) {
      if (!text) return false;
      return text.includes('100%') || text.includes('99%') || text.includes('98%') || text.includes('已完成');
    },
    // 离开当前视频前只认页面上的完成标记，98%、99% 时平台往往还没写成已完成
    isMarkedDone(text) {
      if (!text) return false;
      if (text.includes('未完成') || text.includes('未开始')) return false;
      return text.includes('100%') || text.includes('已完成');
    },
    // 主要是规避firefox会创建多个iframe的问题
    inIframe() {
      return window.top !== window.self;
    },
    // 下滑到最底部，触发课程加载
    scrollToBottom(containerSelector) {
      const el = document.querySelector(containerSelector);
      if (el) el.scrollTop = el.scrollHeight;
    },
    getCurrentClassroomId() {
      const query = new URLSearchParams(location.search);
      const queryId = query.get('classroom_id');
      if (queryId) return queryId;

      const path = location.pathname;
      return path.match(/^\/ai-workspace\/lms-graph\/([^/]+)/)?.[1]
        || path.match(/^\/v2\/web\/studentLog\/([^/]+)/)?.[1]
        || path.match(/\/(\d+)\/studycontent$/)?.[1]
        || '';
    },
    returnUrl() { // 得到课程开始的url
      if (location.pathname.includes('/v2/web/studentLog/') || location.pathname.includes('pro/lms/')) {
        return location.href
      }
      return ""
    },
    isSupportedLearningPage() {
      const path = location.pathname;
      return path.includes('/ai-workspace/lms-graph/')
        || path.includes('/v2/web/')
        || path.includes('/pro/lms/');
    },
    waitForMountTarget(timeout = 15000) {
      const getTarget = () => document.body || document.documentElement;
      const existing = getTarget();
      if (existing) return Promise.resolve(existing);

      return new Promise(resolve => {
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          observer.disconnect();
          clearTimeout(timer);
          resolve(getTarget());
        };
        const observer = new MutationObserver(() => {
          if (getTarget()) finish();
        });
        observer.observe(document, { childList: true, subtree: true });
        document.addEventListener('DOMContentLoaded', finish, { once: true });
        window.addEventListener('load', finish, { once: true });
        const timer = setTimeout(finish, timeout);
      });
    },
    async getDDL() {
      const element = document.querySelector('video') || document.querySelector('audio');
      // 读不到整段时长时不要用一个很短的超时把课程掐掉
      const fallback = 3 * 60 * 60 * 1000;
      if (!element) return fallback;

      let duration = Number(element.duration);
      if (!Number.isFinite(duration) || duration <= 0) {
        await Promise.race([
          new Promise(resolve => element.addEventListener('loadedmetadata', resolve, { once: true })),
          this.sleep(8000)
        ]);
        duration = Number(element.duration);
      }

      if (!Number.isFinite(duration) || duration <= 1) return fallback;

      const rate = Math.max(Number(Config.playbackRate) || 1, 0.5);
      const playMs = (duration * 1000) / rate;
      // 时长经常先报成当前分片长度，保底 30 分钟，避免几秒后就判定超时
      return Math.max(playMs * 3, 30 * 60 * 1000);
    },
    // 关闭挂机/离开检测弹窗，避免遮罩拦截刷课流程
    dismissPopups() {
      const wrappers = document.querySelectorAll('.el-dialog__wrapper, .el-message-box__wrapper');
      for (const wrapper of wrappers) {
        const style = getComputedStyle(wrapper);
        const rect = wrapper.getBoundingClientRect();
        if (style.display === 'none' || style.visibility === 'hidden' || rect.width === 0) continue;
        const text = wrapper.innerText || '';
        const buttons = [...wrapper.querySelectorAll('button')];
        const clickBtn = label => {
          const btn = buttons.find(b => (b.innerText || '').trim().includes(label));
          if (btn) btn.click();
        };
        if (text.includes('好好学习') || text.includes('继续观看')) {
          clickBtn('继续观看');
        } else if (text.includes('报告老师')) {
          clickBtn('取消');
        }
      }
    }
  };

  // ---- 存储工具 ----
  const Store = {
    getProgress(url) {
      const raw = localStorage.getItem(Config.storageKeys.progress);
      const all = Utils.safeJSONParse(raw, {}) || { url: { outside: 0, inside: 0 } };
      if (!all[url]) {
        all[url] = { outside: 0, inside: 0 };
        localStorage.setItem(Config.storageKeys.progress, JSON.stringify(all));
      }
      return { all, current: all[url] };
    },
    setProgress(url, outside, inside = 0) {
      const raw = localStorage.getItem(Config.storageKeys.progress);
      const all = Utils.safeJSONParse(raw, {});
      all[url] = { outside, inside };
      localStorage.setItem(Config.storageKeys.progress, JSON.stringify(all));
    },
    removeProgress(url) {
      const raw = localStorage.getItem(Config.storageKeys.progress);
      const all = Utils.safeJSONParse(raw, {});
      delete all[url];
      localStorage.setItem(Config.storageKeys.progress, JSON.stringify(all));
    },
    getAIConf() {
      const raw = localStorage.getItem(Config.storageKeys.ai);
      const saved = Utils.safeJSONParse(raw, {}) || {};
      const conf = {
        url: saved.url ?? "https://api.deepseek.com/chat/completions",
        key: saved.key ?? "sk-xxxxxxx",
        model: saved.model ?? "deepseek-flash",
        apiFormat: saved.apiFormat ?? "openai", // openai 或 anthropic
        authMethod: saved.authMethod ?? "bearer", // bearer 或 x-api-key
      };
      const retiredModels = {
        'deepseek-chat': 'deepseek-flash',
        'deepseek-reasoner': 'deepseek-flash',
        'deepseek-v4-flash': 'deepseek-flash'
      };
      if (String(conf.url).includes('deepseek.com') && retiredModels[conf.model]) {
        conf.model = retiredModels[conf.model];
      }
      localStorage.setItem(Config.storageKeys.ai, JSON.stringify(conf));
      return conf;
    },
    setAIConf(conf) {
      localStorage.setItem(Config.storageKeys.ai, JSON.stringify(conf));
    },
    getQwenConf() {
      const raw = localStorage.getItem(Config.storageKeys.qwen);
      const saved = Utils.safeJSONParse(raw, {}) || {};
      const conf = {
        url: saved.url ?? 'https://llm-pieg74srnbf94v24.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions',
        key: saved.key ?? '',
        model: saved.model ?? 'qwen3.8-flash',
        apiFormat: 'openai',
        authMethod: 'bearer'
      };
      localStorage.setItem(Config.storageKeys.qwen, JSON.stringify(conf));
      return conf;
    },
    setQwenConf(conf) {
      localStorage.setItem(Config.storageKeys.qwen, JSON.stringify(conf));
    },
    getProClassCount() {
      const value = localStorage.getItem(Config.storageKeys.proClassCount);
      return value ? Number(value) : 1;
    },
    setProClassCount(count) {
      localStorage.setItem(Config.storageKeys.proClassCount, count);
    },
    getFeatureConf() {
      const raw = localStorage.getItem(Config.storageKeys.feature);
      const saved = Utils.safeJSONParse(raw, {}) || {};
      const conf = {
        autoAI: saved.autoAI ?? false,
        autoComment: saved.autoComment ?? false,
        answerProvider: saved.answerProvider === 'deepseek' ? 'deepseek' : 'qwen',
        humanCheckMode: saved.humanCheckMode === 'wait' ? 'wait' : 'skip',
      };
      localStorage.setItem(Config.storageKeys.feature, JSON.stringify(conf));
      return conf;
    },
    setFeatureConf(conf) {
      localStorage.setItem(Config.storageKeys.feature, JSON.stringify(conf));
    },
    getPendingAutoStart() {
      const raw = localStorage.getItem(Config.storageKeys.pendingAutoStart);
      const saved = Utils.safeJSONParse(raw, null);
      if (!saved || !saved.classroomId || !saved.ts) return null;
      if (Date.now() - saved.ts > 30 * 60 * 1000) {
        localStorage.removeItem(Config.storageKeys.pendingAutoStart);
        return null;
      }
      return saved;
    },
    setPendingAutoStart(classroomId = '', returnUrl = '') {
      if (!classroomId) return;
      const prev = this.getPendingAutoStart() || {};
      localStorage.setItem(Config.storageKeys.pendingAutoStart, JSON.stringify({
        classroomId,
        returnUrl: returnUrl || prev.returnUrl || '',
        ts: Date.now()
      }));
    },
    clearPendingAutoStart() {
      localStorage.removeItem(Config.storageKeys.pendingAutoStart);
    },
    trailScope() {
      return Utils.getCurrentClassroomId()
        || this.getPendingAutoStart()?.classroomId
        || location.pathname;
    },
    getTrail() {
      const all = Utils.safeJSONParse(localStorage.getItem(Config.storageKeys.trail), {}) || {};
      return all[this.trailScope()] || { currentTitle: '', currentDetail: '', steps: [] };
    },
    saveTrail(trail) {
      const all = Utils.safeJSONParse(localStorage.getItem(Config.storageKeys.trail), {}) || {};
      all[this.trailScope()] = trail;
      localStorage.setItem(Config.storageKeys.trail, JSON.stringify(all));
    },
    clearTrail() {
      const all = Utils.safeJSONParse(localStorage.getItem(Config.storageKeys.trail), {}) || {};
      delete all[this.trailScope()];
      localStorage.setItem(Config.storageKeys.trail, JSON.stringify(all));
    },
  };

  // ---- UI 面板 ----
  function createPanel() {
    const iframe = document.createElement('iframe');
    iframe.style.position = 'fixed';
    iframe.style.top = '40px';
    iframe.style.left = '40px';
    iframe.style.width = '600px';
    iframe.style.height = '640px';
    iframe.style.zIndex = '999999';
    iframe.style.border = '1px solid #a3a3a3';
    iframe.style.borderRadius = '10px';
    iframe.style.background = '#fff';
    iframe.style.overflow = 'hidden';
    iframe.style.boxShadow = '6px 4px 17px 2px #000000';
    iframe.setAttribute('frameborder', '0');
    iframe.setAttribute('id', 'ykt-helper-iframe');
    iframe.setAttribute('allowtransparency', 'true');
    const mountTarget = document.body || document.documentElement;
    if (!mountTarget) {
      throw new Error('面板挂载点不存在');
    }
    mountTarget.appendChild(iframe);

    const doc = iframe.contentDocument || iframe.contentWindow.document;
    doc.open();
    doc.write(`
                  <style>
              /* 全局重置 */
              html, body { overflow: hidden; margin: 0; padding: 0; font-family: "Segoe UI", "PingFang SC", Avenir, Helvetica, Arial, sans-serif; color: #4a4a4a; background: transparent; }

              /* 主容器 */
              .mini-basic {
                position: absolute;
                inset: 0;
                background: #3a7afe;
                color: white;
                height: 100%;
                width: 100%;
                min-height: 42px;
                min-width: 42px;
                border-radius: 10px;
                text-align: center;
                line-height: 1;
                z-index: 1000000;
                cursor: pointer;
                display: none;
                align-items: center;
                justify-content: center;
                font-weight: bold;
                box-shadow: 0 4px 12px rgba(0,0,0,0);
              }
              .mini-basic.show {
                display: flex;
              }

              /* 面板主容器 */
              .panel {
                width: 100%;
                height: 100%;
                background: white;
                border-radius: 10px;
                position: relative;
                overflow: hidden;
              }

              /* 标题栏 */
              .header {
                text-align: center;
                height: 40px;
                background: #f7f7f7;
                color: #000;
                font-size: 18px;
                line-height: 40px;
                border-radius: 10px 10px 0 0;
                border-bottom: 2px solid #eee;
                cursor: move;
                position: relative;
                display: flex;
                align-items: center;
                justify-content: space-between;
                padding: 0 10px;
              }
              .tools ul {
                margin: 0;
                padding: 0;
                list-style: none;
                display: flex;
                gap: 5px;
              }
              .tools li {
                display: inline-block;
                cursor: pointer;
                font-size: 14px;
                padding: 0 5px;
              }

              /* 内容区 */
              .body {
                font-weight: normal;
                font-size: 13px;
                line-height: 22px;
                height: calc(100% - 85px);
                overflow: hidden;
                padding: 8px 10px 4px;
                box-sizing: border-box;
                display: flex;
                flex-direction: column;
                gap: 8px;
                background: #f6f8fb;
              }
              .status {
                background: #fff;
                border: 1px solid #e6eef8;
                border-radius: 8px;
                padding: 8px 10px;
                flex: none;
              }
              .status-label {
                font-size: 11px;
                color: #8c8c8c;
                letter-spacing: 0.04em;
              }
              .status-main {
                font-size: 14px;
                font-weight: 600;
                color: #1f1f1f;
                line-height: 20px;
              }
              .status-sub {
                font-size: 12px;
                color: #1677ff;
                line-height: 18px;
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
              }
              .timeline {
                flex: 1;
                overflow-y: auto;
                padding: 2px 2px 2px 0;
              }
              .step {
                display: grid;
                grid-template-columns: 16px 1fr;
                gap: 8px;
                margin: 0 0 8px;
              }
              .step-rail {
                position: relative;
              }
              .step-rail::before {
                content: "";
                position: absolute;
                left: 5px;
                top: 12px;
                bottom: -10px;
                width: 2px;
                background: #e5eaf1;
              }
              .step:last-child .step-rail::before { display: none; }
              .step-dot {
                width: 12px;
                height: 12px;
                border-radius: 50%;
                background: #1677ff;
                margin-top: 4px;
                position: relative;
                z-index: 1;
              }
              .step.done .step-dot { background: #52c41a; }
              .step.skip .step-dot { background: #bfbfbf; }
              .step-card {
                background: #fff;
                border: 1px solid #e8eef5;
                border-radius: 8px;
                padding: 7px 9px;
              }
              .step-head {
                display: flex;
                justify-content: space-between;
                gap: 8px;
                align-items: baseline;
              }
              .step-kind {
                font-size: 11px;
                color: #1677ff;
                background: #e6f4ff;
                border-radius: 4px;
                padding: 0 5px;
                margin-right: 6px;
              }
              .step.done .step-kind { color: #389e0d; background: #f6ffed; }
              .step.skip .step-kind { color: #8c8c8c; background: #f5f5f5; }
              .step-title {
                font-size: 13px;
                color: #1f1f1f;
                font-weight: 600;
              }
              .step-state {
                font-size: 11px;
                color: #8c8c8c;
                flex: none;
              }
              .step-detail {
                margin-top: 4px;
                font-size: 12px;
                color: #595959;
                line-height: 18px;
                white-space: pre-wrap;
                max-height: 200px;
                overflow: auto;
              }
              .empty-trail {
                color: #8c8c8c;
                font-size: 12px;
                padding: 12px 4px;
              }
              .runlog {
                flex: none;
                background: #fff;
                border: 1px solid #e8eef5;
                border-radius: 8px;
                padding: 4px 8px;
              }
              .runlog summary {
                cursor: pointer;
                font-size: 12px;
                color: #8c8c8c;
              }
              .info {
                margin: 4px 0 0;
                padding: 0;
                list-style: none;
                max-height: 160px;
                overflow-y: auto;
              }
              .info li {
                margin-bottom: 2px;
                color: #666;
                font-size: 12px;
              }

              /* 设置面板 */
              #settings {
                display: none;
                position: absolute;
                top: 40px;
                left: 0;
                width: 100%;
                height: calc(100% - 40px);
                background: #f4f7fb;
                z-index: 99;
                padding: 16px 16px 12px;
                box-sizing: border-box;
                overflow-y: auto;
              }
              .settings-card {
                background: #fff;
                border: 1px solid #e6eef8;
                border-radius: 12px;
                padding: 14px 14px 6px;
                margin-bottom: 14px;
              }
              .settings-card.is-selected {
                border-color: #91caff;
                box-shadow: 0 0 0 2px rgba(22, 119, 255, 0.12);
              }
              .card-title {
                font-size: 14px;
                font-weight: 650;
                color: #1f1f1f;
                margin-bottom: 6px;
              }
              .card-hint {
                margin: 0 0 12px;
                font-size: 12px;
                line-height: 18px;
                color: #8c8c8c;
              }
              .choice-row {
                display: flex;
                gap: 10px;
                margin-bottom: 4px;
              }
              .choice {
                flex: 1;
                display: flex;
                align-items: center;
                justify-content: center;
                gap: 6px;
                border: 1px solid #d9e2ef;
                border-radius: 8px;
                padding: 10px 8px;
                font-size: 13px;
                color: #1f1f1f;
                cursor: pointer;
                background: #fafcff;
              }
              .choice:has(input:checked) {
                border-color: #1677ff;
                background: #e6f4ff;
                color: #0958d9;
                font-weight: 650;
              }
              .choice input {
                margin: 0;
              }
              .choice-stack {
                display: flex;
                flex-direction: column;
                gap: 10px;
                margin-bottom: 8px;
              }
              .choice.choice-block {
                flex: none;
                justify-content: flex-start;
                line-height: 1.45;
                padding: 12px 14px;
              }

              /* 表单项 */
              .form-item {
                margin-bottom: 12px;
              }
              .form-item label {
                display: block;
                margin-bottom: 5px;
                font-size: 12px;
                color: #333;
              }
              .form-item input[type="text"],
              .form-item input[type="password"] {
                width: 100%;
                padding: 8px;
                border: 1px solid #ddd;
                border-radius: 4px;
                font-size: 12px;
                box-sizing: border-box;
              }

              /* 复选框标签优化：避免“启用”跑到右边 */
              .form-item .checkbox-label {
                display: flex;
                align-items: center;
                gap: 8px;
                font-size: 12px;
                cursor: pointer;
              }
              .form-item .checkbox-label input[type="checkbox"] {
                margin: 0;
                width: auto;
              }

              /* 底部按钮栏 */
              .footer {
                position: absolute;
                bottom: 0;
                left: 0;
                width: 100%;
                background: #f7f7f7;
                color: #c5c5c5;
                font-size: 13px;
                line-height: 25px;
                border-radius: 0 0 10px 10px;
                border-bottom: 2px solid #eee;
                display: flex;
                justify-content: center;
                align-items: center;
                padding: 6px 0;
                gap: 10px;
              }
              .footer button {
                border: none;
                border-radius: 6px;
                color: white;
                cursor: pointer;
                padding: 6px 12px;
                font-size: 12px;
                transition: all 0.2s ease;
              }
              #btn-start {
                background-color: #1677ff;
              }
              #btn-start:hover {
                background-color: #f6ff00;
                color: black;
              }
              #btn-clear {
                background-color: #ff4d4f;
              }
              #btn-setting {
                background-color: #52c41a;
              }
              #btn-stop {
                background-color: #8c8c8c;
              }
              #btn-reload {
                background-color: #fa8c16;
              }

              /* 设置页底部按钮 */
              .settings-footer {
                text-align: center;
                margin-top: 4px;
                display: flex;
                flex-wrap: wrap;
                justify-content: center;
                gap: 10px;
                position: sticky;
                bottom: 0;
                background: #f4f7fb;
                padding: 12px 0 4px;
              }
              .settings-footer button {
                padding: 6px 15px;
                font-size: 12px;
                border-radius: 6px;
                border: none;
                cursor: pointer;
              }
              #save_settings {
                background-color: #1677ff;
                color: white;
              }
              #test_settings {
                background-color: #13c2c2;
                color: white;
              }
              #test_qwen {
                background-color: #722ed1;
                color: white;
              }
              #close_settings {
                background-color: #999;
                color: white;
              }
            </style>

            <div class="mini-basic" id="mini-basic">展开</div>
            <div class="panel" id="panel">
              <div class="header" id="header">
                雨课堂刷课助手
                <div class='tools'>
                  <ul>
                    <li class='minimality' id="minimality">_</li>
                    <li class='question' id="question">?</li>
                  </ul>
                </div>
              </div>
              <div class="body">
                <div class="status">
                  <div class="status-label">当前进度</div>
                  <div class="status-main" id="trail-current">等待开始</div>
                  <div class="status-sub" id="trail-sub">开始刷课后，这里会记下课程、视频和题目</div>
                </div>
                <div class="timeline" id="timeline"></div>
                <details class="runlog">
                  <summary>运行日志</summary>
                  <ul class="info" id="info"></ul>
                </details>
              </div>
              <div id="settings">
                <div class="settings-card">
                  <div class="card-title">答题使用哪个模型</div>
                  <p class="card-hint">看图、复述题目和最后作答都走这里选中的模型。另一个模型的配置会保留。</p>
                  <div class="choice-row">
                    <label class="choice"><input type="radio" name="answer_provider" value="qwen"> 通义千问</label>
                    <label class="choice"><input type="radio" name="answer_provider" value="deepseek"> DeepSeek</label>
                  </div>
                </div>
                <div class="settings-card" id="card-qwen">
                  <div class="card-title">通义千问</div>
                  <p class="card-hint">适合看截图。默认模型 qwen3.8-flash。</p>
                  <div class="form-item">
                    <label>API URL</label>
                    <input type="text" id="qwen_url" placeholder="https://.../compatible-mode/v1/chat/completions">
                  </div>
                  <div class="form-item">
                    <label>API Key</label>
                    <input type="password" id="qwen_key" placeholder="百炼或 MaaS 的 Key">
                  </div>
                  <div class="form-item">
                    <label>模型名</label>
                    <input type="text" id="qwen_model" placeholder="qwen3.8-flash">
                  </div>
                </div>
                <div class="settings-card" id="card-deepseek">
                  <div class="card-title">DeepSeek</div>
                  <p class="card-hint">保留给其他任务，也可以选它来答题。</p>
                  <div class="form-item">
                    <label>API URL</label>
                    <input type="text" id="ai_url" placeholder="https://api.deepseek.com/chat/completions">
                  </div>
                  <div class="form-item">
                    <label>API Key</label>
                    <input type="password" id="ai_key" placeholder="sk-xxxxxxxx">
                  </div>
                  <div class="form-item">
                    <label>模型名</label>
                    <input type="text" id="ai_model" placeholder="deepseek-flash">
                  </div>
                  <div class="form-item">
                    <label>接口格式</label>
                    <select id="ai_format" style="width:100%;padding:8px;border:1px solid #ddd;border-radius:4px;font-size:12px;">
                      <option value="openai">OpenAI（Chat Completions）</option>
                      <option value="anthropic">Anthropic（Messages）</option>
                    </select>
                  </div>
                  <div class="form-item">
                    <label>认证方式</label>
                    <select id="auth_method" style="width:100%;padding:8px;border:1px solid #ddd;border-radius:4px;font-size:12px;">
                      <option value="bearer">Bearer Token</option>
                      <option value="x-api-key">X-API-Key</option>
                    </select>
                  </div>
                </div>
                <div class="settings-card">
                  <div class="card-title">人机验证</div>
                  <p class="card-hint">弹出验证时怎么处理。默认是跳过当前章节。</p>
                  <div class="choice-stack">
                    <label class="choice choice-block"><input type="radio" name="human_check_mode" value="skip"> 跳过当前章节，进入下一章</label>
                    <label class="choice choice-block"><input type="radio" name="human_check_mode" value="wait"> 停在这里，等我手动验证后再继续</label>
                  </div>
                </div>
                <div class="settings-card">
                  <div class="card-title">开关</div>
                  <div class="form-item">
                    <label class="checkbox-label">
                      <input type="checkbox" id="feature_auto_ai">
                      自动作答作业和题目
                    </label>
                  </div>
                  <div class="form-item">
                    <label class="checkbox-label">
                      <input type="checkbox" id="feature_auto_comment">
                      批量区图文和讨论自动回复
                    </label>
                  </div>
                </div>
                <div class="settings-footer">
                  <button id="test_qwen">测试千问</button>
                  <button id="test_settings">测试 DeepSeek</button>
                  <button id="save_settings">保存并关闭</button>
                  <button id="close_settings">取消</button>
                </div>
                <div id="ai_test_result" style="font-size:12px;margin:8px 0 12px;text-align:center;min-height:18px;color:#595959;"></div>
              </div>
              <div class="footer">
                <button id="btn-setting">AI配置</button>
                <button id="btn-clear">清除缓存</button>
                <button id="btn-start">开始刷课</button>
                <button id="btn-stop">停止刷课</button>
                <button id="btn-reload">重新加载</button>
              </div>
            </div>
    `);
    doc.close();

    const ui = {
      iframe,
      doc,
      panel: doc.getElementById('panel'),
      header: doc.getElementById('header'),
      info: doc.getElementById('info'),
      timeline: doc.getElementById('timeline'),
      trailCurrent: doc.getElementById('trail-current'),
      trailSub: doc.getElementById('trail-sub'),
      btnStart: doc.getElementById('btn-start'),
      btnClear: doc.getElementById('btn-clear'),
      btnSetting: doc.getElementById('btn-setting'),
      btnStop: doc.getElementById('btn-stop'),
      btnReload: doc.getElementById('btn-reload'),
      settings: doc.getElementById('settings'),
      saveSettings: doc.getElementById('save_settings'),
      testSettings: doc.getElementById('test_settings'),
      testQwen: doc.getElementById('test_qwen'),
      aiTestResult: doc.getElementById('ai_test_result'),
      closeSettings: doc.getElementById('close_settings'),
      aiUrlInput: doc.getElementById('ai_url'),
      aiKeyInput: doc.getElementById('ai_key'),
      aiModelInput: doc.getElementById('ai_model'),
      qwenUrlInput: doc.getElementById('qwen_url'),
      qwenKeyInput: doc.getElementById('qwen_key'),
      qwenModelInput: doc.getElementById('qwen_model'),
      aiFormatSelect: doc.getElementById('ai_format'),
      authMethodSelect: doc.getElementById('auth_method'),
      featureAutoAI: doc.getElementById('feature_auto_ai'),
      featureAutoComment: doc.getElementById('feature_auto_comment'),
      minimality: doc.getElementById('minimality'),
      question: doc.getElementById('question'),
      miniBasic: doc.getElementById('mini-basic')
    };

    let isDragging = false;
    let startX = 0, startY = 0, startLeft = 0, startTop = 0;
    const hostWindow = window.parent || window;
    const onMove = e => {
      if (!isDragging) return;
      const deltaX = e.screenX - startX;
      const deltaY = e.screenY - startY;
      const maxLeft = Math.max(0, hostWindow.innerWidth - iframe.offsetWidth);
      const maxTop = Math.max(0, hostWindow.innerHeight - iframe.offsetHeight);
      iframe.style.left = Math.min(Math.max(0, startLeft + deltaX), maxLeft) + 'px';
      iframe.style.top = Math.min(Math.max(0, startTop + deltaY), maxTop) + 'px';
    };
    const stopDrag = () => {
      if (!isDragging) return;
      isDragging = false;
      iframe.style.transition = '';
      doc.body.style.userSelect = '';
    };
    ui.header.addEventListener('mousedown', e => {
      isDragging = true;
      startX = e.screenX;
      startY = e.screenY;
      startLeft = parseFloat(iframe.style.left) || 0;
      startTop = parseFloat(iframe.style.top) || 0;
      iframe.style.transition = 'none';
      doc.body.style.userSelect = 'none';
      e.preventDefault();
    });
    doc.addEventListener('mousemove', onMove);
    hostWindow.addEventListener('mousemove', onMove);
    doc.addEventListener('mouseup', stopDrag);
    hostWindow.addEventListener('mouseup', stopDrag);
    hostWindow.addEventListener('blur', stopDrag);

    const normalSize = { width: parseFloat(iframe.style.width), height: parseFloat(iframe.style.height) };
    const miniSize = 64;
    let isMinimized = false;
    const enterMini = () => {
      if (isMinimized) return;
      isMinimized = true;
      ui.panel.style.display = 'none';
      ui.miniBasic.classList.add('show');
      iframe.style.width = miniSize + 'px';
      iframe.style.height = miniSize + 'px';
    };
    const exitMini = () => {
      if (!isMinimized) return;
      isMinimized = false;
      ui.panel.style.display = '';
      ui.miniBasic.classList.remove('show');
      iframe.style.width = normalSize.width + 'px';
      iframe.style.height = normalSize.height + 'px';
    };
    ui.minimality.addEventListener('click', enterMini);
    ui.miniBasic.addEventListener('click', exitMini);

    ui.question.addEventListener('click', () => {
      window.parent.alert('作者：niuwh.cn（重构版 by Codex）');
    });

    const escapeHtml = value => String(value || '').replace(/[&<>"']/g, ch => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[ch]));
    const kindText = {
      video: '视频', audio: '音频', ppt: '课件', course: '课程', question: '题目', homework: '作业', forum: '讨论'
    };
    const stateText = { doing: '进行中', done: '已结束', skip: '已跳过' };
    const renderTrail = trail => {
      const current = trail.currentTitle || '等待开始';
      ui.trailCurrent.textContent = current;
      ui.trailSub.textContent = trail.currentDetail || '开始刷课后，这里会记下课程、视频和题目';
      const steps = trail.steps || [];
      if (!steps.length) {
        ui.timeline.innerHTML = '<div class="empty-trail">还没有记录。开始刷课后，结束的课程、正在播放的视频和题目内容会出现在这里。</div>';
        return;
      }
      ui.timeline.innerHTML = steps.map(step => {
        const state = step.status || 'doing';
        const detail = step.detail ? `<div class="step-detail">${escapeHtml(step.detail)}</div>` : '';
        return `<div class="step ${state}">
          <div class="step-rail"><div class="step-dot"></div></div>
          <div class="step-card">
            <div class="step-head">
              <div class="step-title"><span class="step-kind">${kindText[step.kind] || '记录'}</span>${escapeHtml(step.title)}</div>
              <div class="step-state">${stateText[state] || ''}</div>
            </div>
            ${detail}
          </div>
        </div>`;
      }).join('');
      ui.timeline.scrollTop = ui.timeline.scrollHeight;
    };
    const track = step => {
      const trail = Store.getTrail();
      const steps = trail.steps || [];
      const next = {
        id: step.id,
        kind: step.kind || 'course',
        title: String(step.title || '未命名').slice(0, 80),
        detail: step.detail == null ? (steps.find(item => item.id === step.id)?.detail || '') : String(step.detail).slice(0, 500),
        status: step.status || 'doing'
      };
      const index = steps.findIndex(item => item.id === next.id);
      if (index >= 0) steps[index] = { ...steps[index], ...next };
      else steps.push(next);
      if (steps.length > 60) steps.splice(0, steps.length - 60);
      trail.steps = steps;
      if (next.status === 'doing') {
        trail.currentTitle = next.title;
        trail.currentDetail = next.kind === 'question' ? '正在做题' : `${kindText[next.kind] || '内容'}进行中`;
      } else if (trail.currentTitle === next.title) {
        trail.currentTitle = next.status === 'done' ? `${next.title} 已结束` : next.title;
        trail.currentDetail = next.detail || trail.currentDetail;
      }
      Store.saveTrail(trail);
      renderTrail(trail);
    };
    const showQuestion = text => {
      const body = String(text || '').trim().slice(0, 800);
      const trail = Store.getTrail();
      const steps = trail.steps || [];
      const current = [...steps].reverse().find(item => item.kind === 'question' && item.status === 'doing')
        || [...steps].reverse().find(item => item.kind === 'question');
      if (current) {
        current.detail = body;
        trail.currentTitle = current.title;
        trail.currentDetail = '请核对下面复述的题目';
      }
      Store.saveTrail(trail);
      renderTrail(trail);
      const runlog = doc.querySelector('.runlog');
      if (runlog) runlog.open = true;
      log('模型复述的题目：');
      log(body);
    };
    const noteAnswer = answer => {
      const trail = Store.getTrail();
      const steps = trail.steps || [];
      const current = [...steps].reverse().find(item => item.kind === 'question' && item.status === 'doing')
        || [...steps].reverse().find(item => item.kind === 'question');
      if (!current) return;
      const choice = `选择：${answer}`;
      current.detail = current.detail && !current.detail.includes(choice) ? `${current.detail}\n${choice}` : (current.detail || choice);
      current.status = 'done';
      trail.currentDetail = choice;
      Store.saveTrail(trail);
      renderTrail(trail);
    };
    renderTrail(Store.getTrail());

    const log = message => {
      const li = doc.createElement('li');
      li.innerText = message;
      ui.info.appendChild(li);
      ui.trailSub.textContent = message;
      if (ui.info.lastElementChild) ui.info.lastElementChild.scrollIntoView({ behavior: 'smooth', block: 'end', inline: 'nearest' });
    };

    const warn = message => {
      const li = doc.createElement('li');
      li.innerText = '⚠️警告：' + message;
      ui.info.appendChild(li);
      if (ui.info.lastElementChild) ui.info.lastElementChild.scrollIntoView({ behavior: 'smooth', block: 'end', inline: 'nearest' });
    };

    const error = message => {
      const li = doc.createElement('li');
      li.innerText = '🚨报错：' + message;
      ui.info.appendChild(li);
      if (ui.info.lastElementChild) ui.info.lastElementChild.scrollIntoView({ behavior: 'smooth', block: 'end', inline: 'nearest' });
    };

    const defaultAI = { url: 'https://api.deepseek.com/chat/completions', key: 'sk-xxxxxxx', model: 'deepseek-flash', apiFormat: 'openai', authMethod: 'bearer' };
    const loadAIConf = () => {
      const saved = Store.getAIConf();
      ui.aiUrlInput.value = saved.url || defaultAI.url;
      ui.aiKeyInput.value = saved.key || defaultAI.key;
      ui.aiModelInput.value = saved.model || defaultAI.model;
      ui.aiFormatSelect.value = saved.apiFormat || defaultAI.apiFormat;
      ui.authMethodSelect.value = saved.authMethod || defaultAI.authMethod;
      const qwen = Store.getQwenConf();
      ui.qwenUrlInput.value = qwen.url;
      ui.qwenKeyInput.value = qwen.key;
      ui.qwenModelInput.value = qwen.model;
    };
    const loadFeatureConf = () => {
      const saved = Store.getFeatureConf();
      ui.featureAutoAI.checked = saved.autoAI;
      ui.featureAutoComment.checked = saved.autoComment;
      const provider = saved.answerProvider === 'deepseek' ? 'deepseek' : 'qwen';
      const picked = doc.querySelector(`input[name="answer_provider"][value="${provider}"]`);
      if (picked) picked.checked = true;
      const humanMode = saved.humanCheckMode === 'wait' ? 'wait' : 'skip';
      const humanPicked = doc.querySelector(`input[name="human_check_mode"][value="${humanMode}"]`);
      if (humanPicked) humanPicked.checked = true;
      syncProviderCards();
    };
    const syncProviderCards = () => {
      const provider = doc.querySelector('input[name="answer_provider"]:checked')?.value || 'qwen';
      doc.getElementById('card-qwen')?.classList.toggle('is-selected', provider === 'qwen');
      doc.getElementById('card-deepseek')?.classList.toggle('is-selected', provider === 'deepseek');
    };
    doc.querySelectorAll('input[name="answer_provider"]').forEach(input => {
      input.addEventListener('change', syncProviderCards);
    });
    loadAIConf();
    loadFeatureConf();
    ui.btnSetting.onclick = () => {
      loadAIConf();
      loadFeatureConf();
      ui.settings.style.display = 'block';
    };
    ui.closeSettings.onclick = () => {
      ui.settings.style.display = 'none';
    };
    const readFormAIConf = () => ({
      url: ui.aiUrlInput.value.trim(),
      key: ui.aiKeyInput.value.trim(),
      model: ui.aiModelInput.value.trim(),
      apiFormat: ui.aiFormatSelect.value,
      authMethod: ui.authMethodSelect.value
    });
    const readFormQwenConf = () => ({
      url: ui.qwenUrlInput.value.trim(),
      key: ui.qwenKeyInput.value.trim(),
      model: ui.qwenModelInput.value.trim() || 'qwen3.8-flash',
      apiFormat: 'openai',
      authMethod: 'bearer'
    });
    ui.testSettings.onclick = async () => {
      const conf = readFormAIConf();
      ui.aiTestResult.innerText = '正在测试...';
      ui.testSettings.disabled = true;
      try {
        const reply = await Solver.ping(conf);
        ui.aiTestResult.innerText = `连接成功：${String(reply || '').replace(/\s+/g, ' ').trim().slice(0, 40)}`;
        log('✅ AI 连接测试成功');
      } catch (err) {
        ui.aiTestResult.innerText = String(err);
        log(`AI 连接测试失败：${err}`);
      } finally {
        ui.testSettings.disabled = false;
      }
    };
    ui.testQwen.onclick = async () => {
      const conf = readFormQwenConf();
      ui.aiTestResult.innerText = '正在测试千问...';
      ui.testQwen.disabled = true;
      try {
        const reply = await Solver.ping(conf);
        ui.aiTestResult.innerText = `千问连接成功：${String(reply || '').replace(/\s+/g, ' ').trim().slice(0, 40)}`;
        log('✅ 千问连接测试成功');
      } catch (err) {
        ui.aiTestResult.innerText = String(err);
        log(`千问连接测试失败：${err}`);
      } finally {
        ui.testQwen.disabled = false;
      }
    };
    ui.saveSettings.onclick = () => {
      const conf = readFormAIConf();
      Store.setAIConf(conf);
      Store.setQwenConf(readFormQwenConf());
      const featureConf = {
        autoAI: ui.featureAutoAI.checked,
        autoComment: ui.featureAutoComment.checked,
        answerProvider: doc.querySelector('input[name="answer_provider"]:checked')?.value === 'deepseek' ? 'deepseek' : 'qwen',
        humanCheckMode: doc.querySelector('input[name="human_check_mode"]:checked')?.value === 'wait' ? 'wait' : 'skip'
      };
      Store.setFeatureConf(featureConf);
      ui.settings.style.display = 'none';
      const humanText = featureConf.humanCheckMode === 'wait' ? '人机验证改为停住等待' : '人机验证改为跳过当前章节';
      log(`✅ AI 配置已保存，${humanText}`);
    };

    ui.btnClear.onclick = () => {
      Store.removeProgress(window.parent.location.href);
      localStorage.removeItem(Config.storageKeys.proClassCount);
      Store.clearPendingAutoStart();
      Store.clearTrail();
      renderTrail(Store.getTrail());
      log('已清除当前课程的刷课进度缓存');
    };

    // 停止刷课：清除自动恢复标记后刷新页面，刷新后脚本回到空闲状态（进度缓存保留）
    ui.btnStop.onclick = () => {
      Store.clearPendingAutoStart();
      log('已停止刷课，页面即将刷新');
      window.parent.location.reload();
    };

    // 重新加载：重建自动恢复标记后刷新页面，刷新后自动恢复刷课（停止后点击同样生效）
    ui.btnReload.onclick = () => {
      Store.setPendingAutoStart(Utils.getCurrentClassroomId());
      log('正在重新加载脚本...');
      window.parent.location.reload();
    };

    let startHandler = null;
    let running = false;
    const invokeStart = () => {
      if (running) {
        log('已在刷课中，忽略重复启动');
        return;
      }
      running = true;
      log('启动中...');
      ui.btnStart.innerText = '刷课中...';
      startHandler && startHandler();
    };

    // 后面赋值给panel
    return {
      ...ui,
      log,
      warn,
      error,
      track,
      showQuestion,
      noteAnswer,
      setStartHandler(fn) {
        startHandler = fn;
        ui.btnStart.onclick = invokeStart;
      },
      start() {
        invokeStart();
      },
      resetStartButton(text = '开始刷课') {
        ui.btnStart.innerText = text;
        if (text !== '刷课中...') running = false;
      }
    };
  }

  // ---- 播放器工具 ----
  const mediaDurationState = new WeakMap();
  const Player = {
    RESUME_DELAY: 15000,
    DURATION_STABLE_TICKS: 3,
    noteDuration(media) {
      if (!media) return false;
      const duration = Number(media.duration || 0);
      let state = mediaDurationState.get(media);
      if (!state) {
        state = { last: 0, ticks: 0 };
        mediaDurationState.set(media, state);
      }
      if (!Number.isFinite(duration) || duration <= 1) {
        state.last = 0;
        state.ticks = 0;
        return false;
      }
      if (state.last > 0 && Math.abs(duration - state.last) < 0.3) {
        state.ticks += 1;
      } else {
        state.last = duration;
        state.ticks = 1;
      }
      return state.ticks >= this.DURATION_STABLE_TICKS;
    },
    isDurationStable(media) {
      const state = media ? mediaDurationState.get(media) : null;
      return Boolean(state && state.ticks >= this.DURATION_STABLE_TICKS && state.last > 1);
    },
    stableDuration(media) {
      return media ? (mediaDurationState.get(media)?.last || 0) : 0;
    },
    isDisplayFinished(current, total) {
      const left = String(current || '').trim();
      const right = String(total || '').trim();
      if (!left || !right || left !== right) return false;
      const parts = right.split(':').map(part => Number(part));
      if (!parts.length || parts.some(part => !Number.isFinite(part))) return false;
      return parts.some(part => part > 0);
    },
    isNearEnd(media, threshold = 1) {
      if (!media || !media.isConnected || !this.isDurationStable(media)) return false;
      const duration = this.stableDuration(media);
      const currentTime = Number(media.currentTime || 0);
      return currentTime > 0 && duration - currentTime <= threshold;
    },
    isReadyToPlay(media) {
      if (!media || !media.isConnected || media.ended || media.seeking) return false;
      return media.readyState >= 3;
    },
    applySpeed() {
      const rate = Config.playbackRate;
      const video = document.querySelector('video');
      // 1 倍速不点倍速菜单。切到下一集时菜单还没准备好，点下去会让进度向前跳
      if (rate === 1) {
        if (video && Math.abs(video.playbackRate - 1) > 0.01) video.playbackRate = 1;
        return;
      }
      const speedBtn = document.querySelector('xt-speedlist xt-button') || document.getElementsByTagName('xt-speedlist')[0]?.firstElementChild?.firstElementChild;
      const speedWrap = document.getElementsByTagName('xt-speedbutton')[0];
      if (speedBtn && speedWrap && this.isReadyToPlay(video)) {
        speedBtn.setAttribute('data-speed', rate);
        speedBtn.setAttribute('keyt', `${rate}.00`);
        speedBtn.innerText = `${rate}.00X`;
        const mousemove = document.createEvent('MouseEvent');
        mousemove.initMouseEvent('mousemove', true, true, unsafeWindow, 0, 10, 10, 10, 10, 0, 0, 0, 0, 0, null);
        speedWrap.dispatchEvent(mousemove);
        speedBtn.click();
      } else if (video) {
        video.playbackRate = rate;
      }
    },
    mute() {
      const video = document.querySelector('video');
      if (!video) return;
      video.muted = true;
      video.defaultMuted = true;
      video.volume = 0;
    },
    applyMediaDefault(media) {
      if (!media) return;
      media.play();
      media.volume = 0;
      if (Math.abs(media.playbackRate - Config.playbackRate) > 0.01) {
        media.playbackRate = Config.playbackRate;
      }
    },
    observePause(video, shouldResume = () => true) {
      if (!video) return () => { };
      const canResume = () => {
        this.noteDuration(video);
        if (Utils.isHumanCheckVisible()) return false;
        return shouldResume() && this.isReadyToPlay(video) && !this.isNearEnd(video, 0.2);
      };
      let resumeTimer = null;
      let lastPlayAt = 0;
      const playVideo = () => {
        if (!canResume()) return;
        if (Date.now() - lastPlayAt < this.RESUME_DELAY) return;
        lastPlayAt = Date.now();
        video.play().catch(e => {
          if (!canResume()) return;
          console.warn('自动播放失败:', e);
        });
      };
      const scheduleResume = () => {
        if (resumeTimer) return;
        const pausedAtTime = Number(video.currentTime || 0);
        resumeTimer = setTimeout(() => {
          resumeTimer = null;
          if (!video.paused || !canResume()) return;
          if (Math.abs(Number(video.currentTime || 0) - pausedAtTime) > 0.5) return;
          playVideo();
        }, this.RESUME_DELAY);
      };
      if (video.paused) scheduleResume();
      const onPause = () => { if (canResume()) scheduleResume(); };
      video.addEventListener('pause', onPause);
      const timer = setInterval(() => { if (video.paused && canResume()) scheduleResume(); }, 20000);
      const target = document.getElementsByClassName('play-btn-tip')[0];
      let observer = null;
      if (target) {
        observer = new MutationObserver(list => {
          for (const mutation of list) {
            if (mutation.type === 'childList' && target.innerText === '播放' && canResume()) {
              scheduleResume();
            }
          }
        });
        observer.observe(target, { childList: true });
      }
      return () => {
        video.removeEventListener('pause', onPause);
        clearInterval(timer);
        if (resumeTimer) clearTimeout(resumeTimer);
        if (observer) observer.disconnect();
      };
    },
    waitForEnd(media, timeout = 0) {
      return new Promise(resolve => {
        if (!media) return resolve();
        if (media.ended) return resolve();
        let timer;
        const onEnded = () => {
          clearTimeout(timer);
          resolve();
        };
        media.addEventListener('ended', onEnded, { once: true });
        if (timeout > 0) {
          timer = setTimeout(() => {
            media.removeEventListener('ended', onEnded);
            resolve();
          }, timeout);
        }
      });
    }
  };

  // ---- ai-workspace 路由工具 ----
  const AiWorkspace = {
    normalizeText(text) {
      return String(text || '').replace(/\s+/g, ' ').trim();
    },
    isVisibleElement(element) {
      if (!element || element.nodeType !== 1) return false;
      const view = element.ownerDocument?.defaultView || window;
      const style = view.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none'
        && style.visibility !== 'hidden'
        && rect.width > 0
        && rect.height > 0;
    },
    getRoute() {
      const match = location.pathname.match(/^\/ai-workspace\/lms-graph\/([^/]+)\/([^/]+)\/([^/?#]+)/);
      if (!match) return null;
      const [, classroomId, type, leafId] = match;
      const query = new URLSearchParams(location.search);
      return {
        classroomId,
        type,
        leafId,
        nodeId: query.get('node_id') || ''
      };
    },
    getMediaCandidates() {
      return [...document.querySelectorAll('video, audio')].filter(media => {
        if (!(media instanceof HTMLMediaElement)) return false;
        const rect = media.getBoundingClientRect();
        const isVisible = rect.width > 0 && rect.height > 0;
        return isVisible || media.tagName.toLowerCase() === 'audio';
      });
    },
    getMedia() {
      const candidates = this.getMediaCandidates().filter(media => !media.ended);
      const pool = candidates.length ? candidates : this.getMediaCandidates();
      if (!pool.length) return document.querySelector('video') || document.querySelector('audio');
      const score = media => {
        const rect = media.getBoundingClientRect();
        const area = rect.width * rect.height;
        const playingBoost = !media.paused && !media.ended ? 1_000_000 : 0;
        const currentBoost = Number(media.currentTime || 0);
        return playingBoost + area + currentBoost;
      };
      return [...pool].sort((a, b) => score(b) - score(a))[0];
    },
    isPlayerDone(media, { startTime = 0, minPlayedDelta = 0 } = {}) {
      if (!media || !media.isConnected) return false;
      const currentTime = Number(media.currentTime || 0);
      const playedDelta = Math.max(0, currentTime - startTime);
      if (playedDelta < minPlayedDelta) return false;
      // 时长要连续几次不变，才把它当成整段长度；分片时长不能用来判定结束
      if (!Player.noteDuration(media)) return false;
      const duration = Player.stableDuration(media);
      if (media.ended && duration - currentTime <= 0.5) return true;
      if (duration > 1 && currentTime > 0 && duration - currentTime <= 0.3) return true;
      const display = document.querySelector('.xt_video_player_current_time_display')?.innerText?.trim() || '';
      const [current, total] = display.split(' / ').map(text => text?.trim());
      return Player.isDisplayFinished(current, total);
    },
    keepAlive(shouldResume = () => true) {
      let lastMedia = null;
      let pausedAt = 0;
      let pausedMark = 0;
      const tick = () => {
        if (!shouldResume() || Utils.isHumanCheckVisible()) return;
        const media = this.getMedia();
        if (!media) return;
        if (lastMedia !== media) {
          if (lastMedia) lastMedia.removeEventListener('pause', tick);
          lastMedia = media;
          pausedAt = 0;
          pausedMark = 0;
          media.addEventListener('pause', tick);
        }
        if (!media.muted) {
          media.muted = true;
          media.defaultMuted = true;
          media.volume = 0;
        }
        if (Math.abs(media.playbackRate - Config.playbackRate) > 0.01 && !media.seeking) {
          media.playbackRate = Config.playbackRate;
        }
        Player.noteDuration(media);
        if (media.seeking || media.readyState < 3) {
          pausedAt = 0;
          pausedMark = 0;
          return;
        }
        if (!media.paused) {
          pausedAt = 0;
          pausedMark = 0;
          return;
        }
        if (media.ended || Player.isNearEnd(media, 0.2)) return;
        const currentTime = Number(media.currentTime || 0);
        if (!pausedAt) {
          pausedAt = Date.now();
          pausedMark = currentTime;
          return;
        }
        if (Math.abs(currentTime - pausedMark) > 0.5) {
          pausedAt = Date.now();
          pausedMark = currentTime;
          return;
        }
        if (Date.now() - pausedAt >= Player.RESUME_DELAY) {
          pausedAt = Date.now();
          media.play().catch(() => { });
        }
      };
      const timer = setInterval(tick, 8000);
      document.addEventListener('visibilitychange', tick);
      window.addEventListener('focus', tick);
      tick();
      return () => {
        clearInterval(timer);
        if (lastMedia) lastMedia.removeEventListener('pause', tick);
        document.removeEventListener('visibilitychange', tick);
        window.removeEventListener('focus', tick);
      };
    },
    getActiveLeafTitle() {
      return document.querySelector('.leaf-item.is-active')?.innerText?.replace(/\s+/g, ' ').trim() || '';
    },
    getExerciseDocument() {
      const localHasExercise = document.querySelector('#app .container-body .container-problem')
        || document.querySelector('#app .container-problem')
        || document.querySelector('.container-problem');
      if (localHasExercise) return document;

      const frames = [...document.querySelectorAll('iframe')];
      for (const frame of frames) {
        try {
          const doc = frame.contentDocument;
          if (!doc?.body) continue;
          if (
            doc.querySelector('.container-problem')
            || doc.querySelector('.subject-item')
            || doc.querySelector('.item-body')
          ) {
            return doc;
          }
        } catch (_) {
          // ignore cross-document access failures
        }
      }
      return null;
    },
    getExerciseContainer() {
      const exerciseDoc = this.getExerciseDocument();
      return exerciseDoc?.querySelector('#app .container-body .container-problem')
        || exerciseDoc?.querySelector('#app .container-problem')
        || exerciseDoc?.querySelector('.container-problem')
        || null;
    },
    getExerciseQuestionTabs(root = this.getExerciseContainer()) {
      if (!root) return [];
      const selectors = [
        '.subject-item.J_order',
        '.subject-item',
        '.problem-index-item',
        '.question-index-item',
        '[class*="subject-item"]',
        '[class*="problem-index"]',
        '[class*="question-index"]'
      ].join(',');
      const all = [...root.querySelectorAll(selectors)];
      return all.filter((el, index, arr) => {
        if (!this.isVisibleElement(el)) return false;
        if (arr.indexOf(el) !== index) return false;
        const text = this.normalizeText(el.innerText);
        return text && text.length <= 20;
      });
    },
    getExerciseQuestionBody(root = this.getExerciseContainer()) {
      if (!root) return null;
      const itemType = root.querySelector('.item-type');
      if (itemType?.parentElement && this.isVisibleElement(itemType.parentElement)) return itemType.parentElement;
      const selectors = [
        '.item-body',
        '.problem-content',
        '.question-content',
        '.problem-main',
        '.problem-body',
        '.question-body',
        '[class*="problem-content"]',
        '[class*="question-content"]',
        '[class*="problem-body"]',
        '[class*="question-body"]'
      ];
      for (const selector of selectors) {
        const match = [...root.querySelectorAll(selector)].find(el => this.isVisibleElement(el));
        if (match) return match;
      }
      return root;
    },
    forumStatus() {
      const nodes = [...document.querySelectorAll('span, div, em, strong, p')];
      for (const el of nodes) {
        if (!this.isVisibleElement(el)) continue;
        const text = (el.innerText || '').replace(/\s+/g, '');
        if (text === '未发言' || text === '已发言' || text === '已完成') return text;
      }
      return '';
    },
    forumTopic() {
      const composer = this.findForumComposer();
      const composerTop = composer ? composer.getBoundingClientRect().top : Number.POSITIVE_INFINITY;
      const inOutline = el => Boolean(el.closest('.nav-item-leaf-box, .leaf-item, [class*="leaf"], [class*="nav-item"], [class*="catalog"], [class*="catalogue"], [class*="sidebar"], [class*="outline"]'));
      const isOutlineTitle = text => /^(视频|音频|课件|图文|作业|考试|讨论)\s*[\d.]/.test(text) || (/^(视频|音频|课件)/.test(text) && text.length < 40);
      const hits = [];
      for (const el of document.querySelectorAll('p, div, section, h1, h2, h3, span')) {
        if (!this.isVisibleElement(el) || inOutline(el)) continue;
        if (el.querySelector('textarea, [contenteditable="true"]')) continue;
        const rect = el.getBoundingClientRect();
        if (rect.width < 280 || rect.bottom > composerTop - 4) continue;
        const text = this.normalizeText(el.innerText);
        if (text.length < 20 || text.length > 500) continue;
        if (/发表你的观点|Enter发送|未发言|已发言|讨论区|考核截止/.test(text)) continue;
        if (/\d{4}-\d{2}-\d{2}/.test(text) || isOutlineTitle(text) || !/[。！？]/.test(text)) continue;
        const sameChild = [...el.children].some(child => this.normalizeText(child.innerText) === text);
        if (sameChild) continue;
        hits.push({ text, top: rect.top });
      }
      hits.sort((a, b) => b.top - a.top);
      return hits[0]?.text || '';
    },
    findForumComposer() {
      const fields = [...document.querySelectorAll('textarea, [contenteditable="true"]')].filter(el => this.isVisibleElement(el));
      const hinted = fields.find(el => /发表你的观点|观点|评论|讨论/.test(`${el.getAttribute('placeholder') || ''} ${el.getAttribute('data-placeholder') || ''} ${el.getAttribute('aria-placeholder') || ''}`));
      return hinted || fields[0] || null;
    },
    findForumSendButton(composer) {
      const hint = [...document.querySelectorAll('span, div, p')].find(el => this.isVisibleElement(el) && (el.innerText || '').includes('Enter发送'));
      const row = hint?.parentElement;
      const rowButtons = row ? [...row.querySelectorAll('button, [role="button"]')].filter(el => this.isVisibleElement(el)) : [];
      if (rowButtons.length) return rowButtons[rowButtons.length - 1];
      const scope = composer?.closest('form, section, article') || document;
      const labeled = [...scope.querySelectorAll('button, [role="button"]')].find(el => this.isVisibleElement(el) && /发送|发布/.test(el.innerText || ''));
      return labeled || null;
    },
    setFieldValue(el, text) {
      if (!el) return;
      el.focus();
      if (el.isContentEditable) {
        el.innerText = text;
        el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
        return;
      }
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter) setter.call(el, text);
      else el.value = text;
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    },
    isExerciseAnswered(root = this.getExerciseContainer()) {
      if (!root) return false;
      const disabled = root.querySelector('.el-button.el-button--info.is-disabled.is-plain')
        || root.querySelector('button[disabled]');
      if (disabled) return true;
      const statusSelectors = [
        '.result',
        '.status',
        '.answer-status',
        '[class*="result"]',
        '[class*="status"]'
      ];
      for (const selector of statusSelectors) {
        const statusNode = [...root.querySelectorAll(selector)]
          .find(el => this.isVisibleElement(el) && /已完成|已作答|已提交|回答正确|回答错误/.test(this.normalizeText(el.innerText)));
        if (statusNode) return true;
      }
      return false;
    },
    getExerciseActionButton(root = this.getExerciseContainer(), pattern = /提交|保存|确认|确定|下一题|下一道|下一步|完成本题/) {
      if (!root) return null;
      const selectors = 'button, .el-button, [role="button"], [class*="button"]';
      const nodes = [
        ...root.querySelectorAll(selectors),
        ...document.querySelectorAll(selectors)
      ];
      return nodes.find(el => this.isVisibleElement(el) && pattern.test(this.normalizeText(el.innerText)));
    },
    isActiveLessonMarked() {
      const activeBox = [...document.querySelectorAll('.nav-item-leaf-box')]
        .find(box => box.querySelector('.is-active') || box.classList.contains('is-active'));
      const texts = [
        activeBox?.innerText || '',
        document.querySelector('.leaf-item.is-active')?.innerText || '',
        document.querySelector('.progress-wrap .text')?.innerText || ''
      ];
      if (texts.some(text => Utils.isMarkedDone(text))) return true;
      const classText = [
        activeBox?.className || '',
        ...[...(activeBox?.querySelectorAll('[class]') || [])].slice(0, 40).map(el => el.className)
      ].join(' ');
      return /yiwancheng|is-finish|learned|icon-finish|status-finish/i.test(classText);
    },
    getAllScourse() { // 获得ai-workspace的课程列表
      const list = document?.querySelectorAll(".nav-item-leaf-box")
      if (!list) panel.warn("没有发现课程资源")
      return list
    }
  };

  // 切走页面时，雨课堂会暂停视频。这里拦住切屏事件，让播放继续。
  function preventScreenCheck() {
    const win = unsafeWindow;
    const blackList = new Set(['visibilitychange', 'blur', 'pagehide']);
    if (!win._addEventListener) {
      win._addEventListener = win.addEventListener;
      win.addEventListener = (...args) => blackList.has(args[0]) ? undefined : win._addEventListener(...args);
    }
    if (!document._addEventListener) {
      document._addEventListener = document.addEventListener;
      document.addEventListener = (...args) => blackList.has(args[0]) ? undefined : document._addEventListener(...args);
    }
    try {
      Object.defineProperties(document, {
        hidden: { value: false },
        visibilityState: { value: 'visible' },
        hasFocus: { value: () => true },
        onvisibilitychange: { get: () => undefined, set: () => { } },
        onblur: { get: () => undefined, set: () => { } }
      });
      Object.defineProperties(win, {
        onblur: { get: () => undefined, set: () => { } },
        onpagehide: { get: () => undefined, set: () => { } }
      });
    } catch (_) {}
  }

  // ---- OCR & AI ----
  const Solver = {
    readQuestion(element) {
      if (!element) return '';
      return String(element.innerText || '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    },
    stripReviewNoise(text) {
      return String(text || '')
        .replace(/本题得分[：:][^\n]*/g, '')
        .replace(/正确答案[：:][^\n]*/g, '')
        .replace(/查看解析/g, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    },
    modelCanSee() {
      const conf = this.normalizeConf(this.answerConf());
      const keyOk = Boolean(conf.key) && !String(conf.key).includes('xxxx');
      if (!keyOk) return false;
      if (/deepseek\.com/.test(conf.url || '') && /deepseek-flash/.test(conf.model || '')) return true;
      return /qwen/i.test(conf.model || '');
    },
    answerConf() {
      return Store.getFeatureConf().answerProvider === 'deepseek' ? Store.getAIConf() : Store.getQwenConf();
    },
    examFontUrl(doc) {
      const root = doc || document;
      for (const style of root.querySelectorAll('style')) {
        const html = style.textContent || '';
        if (!/exam-data-decrypt-font|exam_font/.test(html)) continue;
        const matched = html.match(/url\((['"]?)([^"')]+)\1\)/);
        if (matched) return new URL(matched[2], root.baseURI || location.href).href;
      }
      for (const sheet of root.styleSheets || []) {
        let rules;
        try { rules = sheet.cssRules; } catch (_) { continue; }
        for (const rule of rules) {
          if (!(rule instanceof CSSFontFaceRule)) continue;
          const src = rule.style.getPropertyValue('src') || '';
          const family = rule.style.getPropertyValue('font-family') || '';
          if (!/exam_font|exam-data-decrypt-font/.test(`${src} ${family}`)) continue;
          const matched = src.match(/url\((['"]?)([^"')]+)\1\)/);
          if (matched) return new URL(matched[2], root.baseURI || location.href).href;
        }
      }
      return '';
    },
    async loadArrayBuffer(url) {
      if (url.startsWith('blob:') || url.startsWith(location.origin)) {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`字体下载失败 HTTP ${response.status}`);
        return response.arrayBuffer();
      }
      return new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
          method: 'GET',
          url,
          responseType: 'arraybuffer',
          timeout: 30000,
          onload: res => res.status === 200 ? resolve(res.response) : reject(new Error(`字体下载失败 HTTP ${res.status}`)),
          onerror: () => reject(new Error('字体下载失败')),
          ontimeout: () => reject(new Error('字体下载超时'))
        });
      });
    },
    async hashGlyph(commands) {
      let source = '';
      for (const command of commands || []) {
        const pairs = Object.entries(command).sort((a, b) => a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : (a[0] < b[0] ? -1 : 1));
        for (const [key, value] of pairs) source += `${key}${value}`;
      }
      const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(source));
      return [...new Uint8Array(digest).slice(0, 8)].map(byte => byte.toString(16).padStart(2, '0')).join('');
    },
    async loadGlyphHashMap() {
      if (this._glyphHashMap) return this._glyphHashMap;
      panel.log('正在加载字体对照表...');
      const source = await new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
          method: 'GET',
          url: 'https://cdn.jsdelivr.net/gh/novob/yuketang-deobfuscator@main/yuketang-deobfuscator.user.js',
          timeout: 30000,
          onload: res => res.status === 200 ? resolve(res.responseText) : reject(new Error(`对照表下载失败 HTTP ${res.status}`)),
          onerror: () => reject(new Error('对照表下载失败')),
          ontimeout: () => reject(new Error('对照表下载超时'))
        });
      });
      const matched = String(source || '').match(/const MAP_DATA = "([^"]+)"/);
      if (!matched) throw new Error('字体对照表格式已变化');
      const raw = atob(matched[1]);
      const bytes = Uint8Array.from(raw, char => char.charCodeAt(0));
      const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
      const packed = new Uint8Array(await new Response(stream).arrayBuffer());
      const map = {};
      for (let i = 0; i + 10 < packed.length; i += 11) {
        let hash = '';
        for (let j = 0; j < 8; j++) hash += packed[i + j].toString(16).padStart(2, '0');
        map[hash] = (packed[i + 8] << 16) | (packed[i + 9] << 8) | packed[i + 10];
      }
      this._glyphHashMap = map;
      return map;
    },
    async decodeQuestion(element) {
      const raw = this.stripReviewNoise(this.readQuestion(element));
      const chars = [...new Set(raw.match(/[\u4e00-\u9fff]/g) || [])];
      if (!chars.length) return raw;
      const parser = window.opentype || (typeof opentype !== 'undefined' ? opentype : null);
      if (!parser) throw new Error('字体解析库未加载');
      const fontUrl = this.examFontUrl(element.ownerDocument || document);
      if (!fontUrl) throw new Error('没有找到加密字体');
      if (!this._fontCache) this._fontCache = {};
      if (!this._fontCache[fontUrl]) {
        const buffer = await this.loadArrayBuffer(fontUrl);
        this._fontCache[fontUrl] = parser.parse(buffer);
      }
      const font = this._fontCache[fontUrl];
      const hashMap = await this.loadGlyphHashMap();
      const mapping = {};
      for (const char of chars) {
        const glyph = font.charToGlyph(char);
        if (!glyph?.path?.commands?.length) continue;
        const hash = await this.hashGlyph(glyph.path.commands);
        const delta = hashMap[hash];
        if (delta !== undefined) mapping[char] = String.fromCodePoint(delta + 0x3400);
      }
      const mapped = Object.keys(mapping).length;
      panel.log(`字体还原 ${mapped}/${chars.length} 个字`);
      if (mapped < Math.max(3, Math.ceil(chars.length * 0.5))) return '';
      return raw.replace(/[\u4e00-\u9fff]/g, char => mapping[char] || char);
    },
    async shootQuestion(element) {
      panel.log('正在截图...');
      const canvas = await html2canvas(element, {
        useCORS: true,
        logging: false,
        scale: 2,
        backgroundColor: '#ffffff'
      });
      return canvas.toDataURL('image/png');
    },
    async captureQuestion(element) {
      if (!element) return null;
      try {
        const decoded = await this.decodeQuestion(element);
        if (decoded && decoded.replace(/\s/g, '').length > 8) {
          panel.log('已按加密字体还原题目');
          return { image: '', text: decoded };
        }
      } catch (err) {
        panel.log(`字体还原失败：${err.message || err}`);
      }
      try {
        const image = await this.shootQuestion(element);
        if (image && this.modelCanSee()) {
          panel.log('字体还原失败，改用截图');
          return { image, text: '题目截图' };
        }
        const text = await this.recognize(element);
        return { image: '', text: this.stripReviewNoise(text) };
      } catch (err) {
        panel.log(`截图失败：${err.message || err}`);
        return null;
      }
    },
    normalizeConf(conf) {
      const next = { ...conf };
      let url = String(next.url || '').trim();
      if (url && !/^https?:\/\//i.test(url)) url = 'https://' + url;
      const retiredModels = {
        'deepseek-chat': 'deepseek-flash',
        'deepseek-reasoner': 'deepseek-flash',
        'deepseek-v4-flash': 'deepseek-flash'
      };
      if (url.includes('deepseek.com') && retiredModels[next.model]) next.model = retiredModels[next.model];
      if (url.includes('maas.aliyuncs.com') || url.includes('dashscope.aliyuncs.com')) {
        try {
          const parsed = new URL(url);
          const path = parsed.pathname.replace(/\/+$/, '');
          if (path.endsWith('/v1') || path.endsWith('/compatible-mode/v1')) {
            parsed.pathname = `${path}/chat/completions`;
            parsed.search = '';
            parsed.hash = '';
            url = parsed.toString();
          }
        } catch (_) {}
      }
      if (url.includes('deepseek.com') && (next.apiFormat || 'openai') !== 'anthropic') {
        try {
          const parsed = new URL(url);
          const path = parsed.pathname.replace(/\/+$/, '');
          if (parsed.hostname === 'api.deepseek.com' && (path === '' || path === '/v1')) {
            parsed.pathname = '/chat/completions';
            parsed.search = '';
            parsed.hash = '';
            url = parsed.toString();
          }
        } catch (_) {}
      }
      next.url = url;
      return next;
    },
    requestChat(prompt, systemPrompt, confOverride = null, maxTokens = 1024, images = null) {
      const saved = this.normalizeConf(confOverride || Store.getAIConf());
      const API_URL = saved.url;
      const API_KEY = saved.key;
      const MODEL_NAME = saved.model;
      const API_FORMAT = saved.apiFormat || 'openai';
      const AUTH_METHOD = saved.authMethod || 'bearer';
      return new Promise((resolve, reject) => {
        if (!API_URL) {
          reject('请填写 API URL');
          return;
        }
        if (!API_KEY || API_KEY.includes('sk-xxxx')) {
          const msg = '⚠️ 请在 [AI配置] 中填写有效的 API Key';
          panel.log(msg);
          reject(msg);
          return;
        }
        const authHeader = AUTH_METHOD === 'x-api-key'
          ? { 'x-api-key': API_KEY }
          : { 'Authorization': `Bearer ${API_KEY}` };
        const headers = { 'Content-Type': 'application/json', ...authHeader };
        const imageList = Array.isArray(images) ? images.filter(Boolean) : [];
        const userContent = imageList.length && API_FORMAT !== 'anthropic'
          ? [
            { type: 'text', text: prompt },
            ...imageList.map(url => ({ type: 'image_url', image_url: { url, detail: 'high' } }))
          ]
          : prompt;
        let body;
        if (API_FORMAT === 'anthropic') {
          if (API_URL.includes('api.anthropic.com')) headers['anthropic-version'] = '2023-06-01';
          body = {
            model: MODEL_NAME,
            max_tokens: maxTokens,
            system: systemPrompt,
            messages: [{ role: 'user', content: prompt }]
          };
        } else {
          body = {
            model: MODEL_NAME,
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: userContent }
            ],
            temperature: 0.1,
            max_tokens: maxTokens
          };
          if (String(API_URL).includes('deepseek.com')) body.thinking = { type: 'disabled' };
          if (String(API_URL).includes('aliyuncs.com') || /qwen/i.test(MODEL_NAME)) body.enable_thinking = false;
        }
        GM_xmlhttpRequest({
          method: 'POST',
          url: API_URL,
          headers,
          data: JSON.stringify(body),
          timeout: 120000,
          onload: res => {
            if (res.status !== 200) {
              const bodyText = String(res.responseText || (typeof res.response === 'string' ? res.response : '') || '').trim();
              const err = (res.status === 404 && !bodyText)
                ? `请求被篡改猴拦截。请确认脚本头部允许访问该域名，并在篡改猴里放行。当前地址：${API_URL}`
                : `请求失败: HTTP ${res.status} - ${bodyText.slice(0, 180)}`;
              panel.log(err);
              reject(err);
              return;
            }
            try {
              const json = JSON.parse(res.responseText);
              const message = json.choices?.[0]?.message;
              const answerText = json.content?.[0]?.text
                || message?.content
                || message?.reasoning_content
                || '';
              if (!String(answerText).trim()) {
                reject('接口已连通，但没有返回文本');
                return;
              }
              resolve(answerText);
            } catch (_) {
              reject('JSON 解析失败');
            }
          },
          onerror: () => reject('网络错误'),
          ontimeout: () => reject('请求超时')
        });
      });
    },
    ping(conf) {
      return this.requestChat('只回复两个字：成功', '你是连接测试助手，只按用户要求回复。', conf, 64);
    },
    httpGet(url) {
      return new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
          method: 'GET',
          url,
          timeout: 20000,
          headers: {
            'Accept-Language': 'zh-CN,zh;q=0.9',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
          },
          onload: res => {
            if (res.status !== 200 || !res.responseText) {
              reject(new Error(`HTTP ${res.status}`));
              return;
            }
            resolve(res.responseText);
          },
          onerror: () => reject(new Error('网络错误')),
          ontimeout: () => reject(new Error('超时'))
        });
      });
    },
    searchQuery(questionText) {
      let text = String(questionText || '').replace(/\s+/g, ' ').trim();
      text = text.replace(/^(单选题|多选题|判断题|填空题|选择题)\s*/, '');
      const optionAt = text.search(/\s[A-F][\.、．]/);
      if (optionAt > 8) text = text.slice(0, optionAt);
      return text.slice(0, 80).trim();
    },
    extractSearchSnippets(html) {
      const doc = new DOMParser().parseFromString(String(html || ''), 'text/html');
      const nodes = doc.querySelectorAll('li.b_algo h2, li.b_algo p, .b_caption p');
      const snippets = [];
      nodes.forEach(node => {
        const text = String(node.innerText || '').replace(/\s+/g, ' ').trim();
        if (text.length < 12 || snippets.includes(text)) return;
        snippets.push(text.slice(0, 240));
      });
      snippets.sort((a, b) => Number(/答案|正确/.test(b)) - Number(/答案|正确/.test(a)));
      return snippets.slice(0, 5);
    },
    async searchQuestion(questionText) {
      const query = this.searchQuery(questionText);
      if (query.length < 6) return '';
      panel.log('正在搜题...');
      try {
        const html = await this.httpGet(`https://cn.bing.com/search?q=${encodeURIComponent(query + ' 答案')}&setlang=zh-Hans`);
        const snippets = this.extractSearchSnippets(html);
        if (!snippets.length) {
          panel.log('没有搜到可用结果，改由 AI 直接作答');
          return '';
        }
        panel.log(`搜到 ${snippets.length} 条结果，交给 AI 对照`);
        return snippets.join('\n');
      } catch (err) {
        panel.log(`搜题失败，改由 AI 直接作答：${err.message || err}`);
        return '';
      }
    },
    async recognize(element) {
      if (!element) return '无元素';
      try {
        panel.log('正在截图...');
        const canvas = await html2canvas(element, {
          useCORS: true,
          logging: false,
          scale: 2,
          backgroundColor: '#ffffff'
        });
        panel.log('正在 OCR 识别 (首轮较慢)...');
        const { data: { text } } = await Tesseract.recognize(canvas, 'chi_sim', {
          logger: m => {
            if (m.status === 'downloading tesseract lang') {
              console.log(`正在下载语言包 ${(m.progress * 100).toFixed(0)}%`);
            }
          }
        });
        return text.replace(/\s+/g, ' ').trim();
      } catch (err) {
        console.error('OCR error:', err);
        panel.log(`OCR 失败: ${err.message || '网络错误'}`);
        return 'OCR识别出错';
      }
    },
    questionChoices(itemBodyElement) {
      if (!itemBodyElement) return [];
      const listContainer = itemBodyElement.querySelector('.list-inline.list-unstyled-radio') ||
        itemBodyElement.querySelector('.list-unstyled.list-unstyled-radio') ||
        itemBodyElement.querySelector('.list-unstyled') ||
        itemBodyElement.querySelector('ul.list') ||
        itemBodyElement.querySelector('[class*="option-list"]') ||
        itemBodyElement.querySelector('[class*="answer-list"]') ||
        itemBodyElement.querySelector('ul') ||
        itemBodyElement.querySelector('[role="radiogroup"]');
      const listed = (() => {
        if (!listContainer) return [];
        const rows = [...listContainer.querySelectorAll('li')].filter(node => node.querySelector('.el-radio, .el-checkbox, input[type="radio"], input[type="checkbox"], [role="radio"], [role="checkbox"]'));
        if (rows.length >= 2) return rows;
        return [...listContainer.querySelectorAll('.el-radio, .el-checkbox, [role="radio"], [role="checkbox"]')];
      })();
      if (listed.length >= 2) return listed;
      return this.judgeIconChoices(itemBodyElement);
    },
    judgeIconChoices(itemBodyElement) {
      if (!itemBodyElement) return [];
      const nodes = [...itemBodyElement.querySelectorAll('button, [role="button"], div, span')].filter(el => {
        if (!AiWorkspace.isVisibleElement(el)) return false;
        const rect = el.getBoundingClientRect();
        if (rect.width < 24 || rect.width > 72 || rect.height < 24 || rect.height > 72) return false;
        if (Math.abs(rect.width - rect.height) > 14) return false;
        const text = (el.innerText || '').replace(/\s+/g, '');
        if (text.length > 1) return false;
        const mark = `${el.className || ''} ${el.innerHTML || ''}`;
        return /check|close|right|wrong|correct|error|tick|cross|judge|icon|svg/i.test(mark) || el.querySelector('svg, i');
      });
      nodes.sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
      for (let i = 0; i < nodes.length - 1; i++) {
        const left = nodes[i].getBoundingClientRect();
        const right = nodes[i + 1].getBoundingClientRect();
        const sameRow = Math.abs(left.top - right.top) < 16;
        const near = right.left > left.left && right.left - left.right < 120;
        if (sameRow && near) return [nodes[i], nodes[i + 1]];
      }
      return [];
    },
    detectQuestionType(itemBodyElement) {
      const choices = this.questionChoices(itemBodyElement);
      const hasCheckbox = choices.some(choice => choice.matches('.el-checkbox, [role="checkbox"]') || choice.querySelector('.el-checkbox, input[type="checkbox"], [role="checkbox"]'));
      const labels = choices.map(choice => (choice.innerText || '').replace(/\s+/g, ''));
      const polarity = text => {
        if (/不正确|不对|错误|错|否|False/i.test(text)) return 'false';
        if (/正确|对|是|True/i.test(text)) return 'true';
        return '';
      };
      const pageText = `${itemBodyElement?.innerText || ''} ${itemBodyElement?.parentElement?.innerText || ''}`;
      if (/判断题/.test(pageText.slice(0, 80))) return 'judge';
      const judgeLabels = labels.map(polarity).filter(Boolean);
      if (!hasCheckbox && labels.length === 2 && judgeLabels.length === 2 && judgeLabels[0] !== judgeLabels[1]) return 'judge';
      if (!hasCheckbox && choices.length === 2 && labels.every(text => text.length <= 1)) return 'judge';
      if (hasCheckbox) return 'multiple';
      return 'single';
    },
    revealedResult(element) {
      const text = String(element?.innerText || '');
      if (!/本题得分|正确答案/.test(text)) return null;
      const score = text.match(/本题得分[：:]\s*([0-9.]+)/);
      const answer = text.match(/正确答案[：:]\s*([^\n]+)/);
      return {
        score: score ? score[1] : '',
        answer: answer ? answer[1].replace(/\s+/g, ' ').trim() : ''
      };
    },
    questionStem(element) {
      return this.stripReviewNoise(element?.innerText || '').replace(/\s+/g, '').slice(0, 120);
    },
    questionTypeName(questionType) {
      if (questionType === 'multiple') return '多选题';
      if (questionType === 'judge') return '判断题';
      return '单选题';
    },
    questionTypeRule(questionType, optionCount) {
      const maxChar = String.fromCharCode(65 + Math.max(optionCount, 1) - 1);
      const rangeStr = optionCount ? `A-${maxChar}` : 'A-D';
      if (questionType === 'multiple') return `这是多选题，有 ${optionCount || '若干'} 个选项，范围 ${rangeStr}。少选不得分，每个正确选项都要选上，字母连写，例如 ABCD。`;
      if (questionType === 'judge') return '这是判断题。只能输出“对”或“错”，不要输出字母。';
      return `这是单选题，有 ${optionCount || '若干'} 个选项，范围 ${rangeStr}。只能选择一个选项，正确答案只能有一个字母。`;
    },
    async askAI(questionText, optionCount = 0, image = '', questionType = 'single') {
      const answerConf = this.answerConf();
      const modelName = Store.getFeatureConf().answerProvider === 'deepseek' ? 'DeepSeek' : '千问';
      if (image) {
        panel.log(`正在让${modelName}复述截图中的题目...`);
        const restated = this.stripReviewNoise(await this.requestChat(
          '请逐字复述图片中的完整题目和所有选项。保留题干、选项字母和选项内容，按原来的换行。不要作答，不要解释。',
          '你只负责把图片里的题目原样复述出来。',
          answerConf,
          1024,
          [image]
        ));
        if (restated.replace(/\s/g, '').length < 8) throw new Error('模型没有复述出题目');
        panel.showQuestion(restated);
        panel.log('复述已写在上方题目卡片，8 秒后开始搜索并提交');
        await Utils.sleep(8000);
        const evidence = await this.searchQuestion(restated);
        panel.log(evidence ? '正在根据复述和搜索结果作答...' : '没有搜到结果，改由模型根据复述作答...');
        const prompt = `
你是专业做题助手。下面题目是模型从截图复述的，搜索结果只在明确对应这道题时采用。
强约束：
1) ${this.questionTypeRule(questionType, optionCount)}
2) 按复述中选项出现顺序映射 A/B/C/D...
3) 输出格式必须包含“正确答案：”前缀，例如 正确答案：A 或 正确答案：ABD 或 正确答案：对
题目内容：
${restated}
${evidence ? `搜索结果：\n${evidence}` : ''}
`;
        return this.requestChat(prompt, '你只输出答案。判断题输出对或错，选择题输出字母。搜索结果只在与本题一致时才采用。', answerConf);
      }
      panel.showQuestion(questionText);
      panel.log('还原后的题目已写在上方卡片，8 秒后开始搜索并提交');
      await Utils.sleep(8000);
      const evidence = await this.searchQuestion(questionText);
      const prompt = `
你是专业做题助手。先看搜索结果是否就是这道题，再看页面上的选项。
强约束：
1) 搜索结果明确对应本题时，采用其中的答案；结果是别的题、互相矛盾或没有答案时，再根据题目判断
2) ${this.questionTypeRule(questionType, optionCount)}
3) 按选项出现顺序映射 A/B/C/D...
4) 输出格式必须包含“正确答案：”前缀，例如 正确答案：A 或 正确答案：ABD 或 正确答案：对
${evidence ? `搜索结果：\n${evidence}\n` : ''}题目内容：
${questionText}
`;
      return this.requestChat(prompt, "你是一个只输出答案的助手。判断题输出'对'或'错'，选择题输出字母。搜索结果只在与本题一致时才采用。", answerConf);
    },
    async autoSelectAndSubmit(aiResponse, itemBodyElement, questionType = 'single') {
      const match = aiResponse.match(/(?:正确)?答案[：:]?\s*([A-F]+(?:[,，][A-F]+)*|[对错]|正确|错误)/i);
      if (!match) {
        panel.log('⚠️ 未提取到有效选项，请人工检查');
        return;
      }
      let answerRaw = match[1].replace(/[,，]/g, '').trim();
      const map = { 'A': 0, 'B': 1, 'C': 2, 'D': 3, 'E': 4, 'F': 5 };
      const choices = this.questionChoices(itemBodyElement);
      if (choices.length < 2) {
        panel.log('⚠️ 未找到选项容器');
        return;
      }
      const polarity = text => {
        const compact = String(text || '').replace(/\s+/g, '');
        if (/不正确|不对|错误|错|否|False/i.test(compact)) return 'false';
        if (/正确|对|是|True/i.test(compact)) return 'true';
        return '';
      };
      let targetIndices = [];
      if (questionType === 'judge') {
        const upper = answerRaw.toUpperCase();
        const want = (answerRaw === '错' || answerRaw === '错误' || upper === 'B') ? 'false'
          : (answerRaw === '对' || answerRaw === '正确' || upper === 'A') ? 'true' : '';
        const found = want ? choices.findIndex(choice => polarity(choice.innerText) === want) : -1;
        targetIndices = [found >= 0 ? found : (want === 'false' ? 1 : 0)];
        answerRaw = want === 'false' ? '错' : '对';
      } else {
        for (const char of answerRaw.toUpperCase()) {
          if (map[char] !== undefined) targetIndices.push(map[char]);
        }
        if (questionType === 'single') targetIndices = targetIndices.slice(0, 1);
      }
      targetIndices = [...new Set(targetIndices)].filter(idx => idx < choices.length);
      if (!targetIndices.length) return;
      panel.log(`✅ ${this.questionTypeName(questionType)}，选择：${answerRaw}`);
      panel.noteAnswer(answerRaw);

      for (const idx of targetIndices) {
        const choice = choices[idx];
        if (!choice) continue;
        const chosen = choice.classList.contains('is-checked') || choice.querySelector('.is-checked, input:checked');
        if (chosen) continue;
        const clickable = choice.querySelector('label.el-radio') ||
          choice.querySelector('label.el-checkbox') ||
          choice.querySelector('.el-radio__label') ||
          choice.querySelector('.el-checkbox__label') ||
          choice.querySelector('[role="radio"]') ||
          choice.querySelector('[role="checkbox"]') ||
          choice.querySelector('input') ||
          choice;
        await Utils.humanClick(clickable, 900, 2200);
      }
      const submitBtn = (() => {
        const ownerDocument = itemBodyElement.ownerDocument || document;
        const roots = [itemBodyElement.parentElement, itemBodyElement, ownerDocument].filter(Boolean);
        const matchText = text => /提交|保存|确认|确定|提交答案/.test(text);
        for (const root of roots) {
          const local = root.querySelectorAll('button, .el-button, [role="button"]');
          for (const btn of local) {
            if (btn.offsetParent !== null && matchText(btn.innerText || '')) return btn;
          }
        }
        const global = ownerDocument.querySelectorAll('.el-button.el-button--primary.el-button--medium');
        for (const btn of global) {
          if (matchText(btn.innerText || '') && btn.offsetParent !== null) return btn;
        }
        return null;
      })();
      if (submitBtn) {
        panel.log('正在提交...');
        await Utils.humanClick(submitBtn, 1400, 3200);
      } else {
        panel.log('⚠️ 未找到提交按钮，请手动提交');
      }
    }
  };

  // ---- v2 逻辑 ----
  class V2Runner {
    constructor(panel) {
      this.panel = panel;
      this.baseUrl = location.href;
      const { current } = Store.getProgress(this.baseUrl);
      this.outside = current.outside;
      this.inside = current.inside;
      this.shouldStop = false;
    }

    updateProgress(outside, inside = 0) {
      this.outside = outside;
      this.inside = inside;
      Store.setProgress(this.baseUrl, outside, inside);
    }

    async waitForExternalHandoff(timeout = 1200) {
      await Utils.sleep(timeout);
      if (document.visibilityState === 'hidden' || !document.hasFocus()) {
        this.shouldStop = true;
        this.panel.log('已交给新页面继续，返回目录页后会自动续跑');
        return true;
      }
      return false;
    }

    checkCompletionStatus(statusBox, statusText) {
      // 1. 检查明确的完成状态文本
      if (statusText.includes('已完成') || statusText.includes('已读')) {
        return true;
      }

      // 2. 检查明确的未完成状态文本
      if (statusText.includes('未开始') || statusText.includes('未读') || statusText.includes('进行中')) {
        return false;
      }

      // 3. 检查学习进度数字比例
      const progressMatch = statusText.match(/(\d+)\/(\d+)/);
      if (progressMatch) {
        const [, current, total] = progressMatch;
        const currentNum = parseInt(current, 10);
        const totalNum = parseInt(total, 10);

        // 根据数字进度判断：相等且大于0表示已完成
        return currentNum === totalNum && totalNum > 0;
      }

      // 默认返回false（未完成）
      return false;
    }

    async run() {
      this.panel.log(`检测到已播放到第 ${this.outside} 集，继续刷课...`);
      // 在课件页恢复时直接续播当前内容，不重新走列表流程
      if (location.pathname.includes('/studentCards/')) {
        const videoBox = document.querySelector('.video-box');
        const boxText = videoBox?.innerText || '';
        if ((videoBox || document.querySelector('video')) && !boxText.includes('已完成')) {
          this.panel.log('检测到当前课件页，直接续播当前内容');
          const played = await this.waitCoursewareVideo();
          if (!played) this.panel.log('当前课件等待后仍未显示已完成，返回目录继续');
          history.back();
          await Utils.sleep(1000);
        }
      }
      while (true) {
        await this.autoSlide();
        const list = document.querySelector('.logs-list')?.childNodes;
        if (!list || !list.length) {
          // 可能停留在课件页：跳回目录页继续，避免无限重试
          const pending = Store.getPendingAutoStart();
          const returnUrl = pending?.returnUrl
            || (pending?.classroomId ? `/v2/web/studentLog/${pending.classroomId}` : '');
          if (returnUrl && !location.pathname.includes('/studentLog/')) {
            this.panel.log('当前页面无课程列表，返回目录页继续');
            location.href = returnUrl;
            return;
          }
          this.panel.log('未找到课程列表，稍后重试');
          await Utils.sleep(2000);
          continue;
        }
        console.log(`当前集数:${this.outside}/全部集数${list.length}`);
        if (this.outside >= list.length) {
          this.panel.log('课程刷完啦 🎉');
          this.panel.track({ id: 'course-done', kind: 'course', title: '本课目录已全部结束', status: 'done', detail: '没有更多内容' });
          this.panel.resetStartButton('刷完啦~');
          Store.removeProgress(this.baseUrl);
          Store.clearPendingAutoStart();
          break;
        }
        const course = list[this.outside]?.querySelector('.content-box')?.querySelector('section');
        if (!course) {
          this.panel.log('未找到当前课程节点，跳过');
          this.updateProgress(this.outside + 1, 0);
          continue;
        }
        const type = course.querySelector('.tag')?.querySelector('use')?.getAttribute('xlink:href') || 'piliang';
        const title = course.querySelector('h2')?.innerText?.trim() || `第${this.outside + 1}项`;
        const kind = type.includes('shipin') ? 'video' : type.includes('kejian') ? 'ppt' : type.includes('ketang') ? 'course' : 'course';
        const stepId = `v2-${this.outside}`;

        // 预检查完成状态
        const statusBox = course.querySelector('.statistics-box .aside');
        const statusText = statusBox?.innerText || '';

        // 判断是否已完成
        let isCompleted = this.checkCompletionStatus(statusBox, statusText);

        if (isCompleted) {
          this.panel.log(`✅ ${title} 已完成，跳过`);
          this.panel.track({ id: stepId, kind, title, status: 'done', detail: '已完成' });
          this.updateProgress(this.outside + 1, 0);
          continue;
        }

        this.panel.log(`刷课状态：第 ${this.outside + 1}/${list.length} 个，类型 ${type}，标题：${title}`);
        this.panel.track({ id: stepId, kind, title, status: 'doing', detail: `第 ${this.outside + 1}/${list.length} 个` });
        if (type.includes('shipin')) {
          await this.handleVideo(course);
        } else if (type.includes('piliang')) {
          await this.handleBatch(course, list);
        } else if (type.includes('ketang')) {
          await this.handleClassroom(course);
        } else if (type.includes('kejian')) {
          await this.handleCourseware(course);
        } else if (type.includes('kaoshi')) {
          this.panel.log('考试区域脚本会被屏蔽，已跳过');
          this.updateProgress(this.outside + 1, 0);
        } else {
          this.panel.log('非视频/批量/课件/考试，已跳过');
          this.updateProgress(this.outside + 1, 0);
        }
        if (this.shouldStop) return;
      }
    }

    async autoSlide() {
      const frequency = Math.floor((this.outside + 1) / 20) + 1;
      for (let i = 0; i < frequency; i++) {
        Utils.scrollToBottom('.viewContainer');
        await Utils.sleep(800);
      }
    }

    async handleVideo(course) {
      await Utils.humanClick(course, 1000, 2200);
      if (await this.waitForExternalHandoff(1500)) return;
      await Utils.sleep(3000);
      const progressNode = document.querySelector('.progress-wrap')?.querySelector('.text');
      const title = document.querySelector('.title')?.innerText || '视频';
      this.panel.track({ id: `v2-${this.outside}`, kind: 'video', title, status: 'doing' });
      const isDeadline = document.querySelector('.box')?.innerText.includes('已过考核截止时间');
      if (isDeadline) this.panel.log(`${title} 已过截止，进度不再增加，将直接跳过`);
      Player.applySpeed();
      Player.mute();
      const video = document.querySelector('video');
      const stopObserve = Player.observePause(video);
      const done = await Utils.poll(() => {
        Utils.dismissPopups();
        return isDeadline || Utils.isMarkedDone(progressNode?.innerHTML);
      }, { interval: 5000, timeout: await Utils.getDDL() });
      stopObserve();
      if (!done) this.panel.log(`${title} 等待后仍未显示已完成，进入下一项`);
      this.panel.track({ id: `v2-${this.outside}`, kind: 'video', title, status: 'done', detail: done ? '播放结束' : '未显示已完成，已继续' });
      this.updateProgress(this.outside + 1, 0);
      history.back();
      await Utils.sleep(1200);
    }

    async handleBatch(course, list) {
      const expandBtn = course.querySelector('.sub-info')?.querySelector('.gray')?.querySelector('span');
      if (!expandBtn) {
        this.panel.log('未找到批量展开按钮，跳过');
        this.updateProgress(this.outside + 1, 0);
        return;
      }
      expandBtn.click();
      await Utils.sleep(1200);
      const activities = list[this.outside]?.querySelector('.leaf_list__wrap')?.querySelectorAll('.activity__wrap') || [];
      let idx = this.inside;
      this.panel.log(`进入批量区，内部进度 ${idx}/${activities.length}`);
      while (idx < activities.length) {
        const item = activities[idx];
        if (!item) break;

        const tagText = item.querySelector('.tag')?.innerText || '';
        const tagHref = item.querySelector('.tag')?.querySelector('use')?.getAttribute('xlink:href') || '';
        const title = item.querySelector('h2')?.innerText || `第${idx + 1}项`;

        // 检查当前项目的完成状态
        const statusBox = item.querySelector('.statistics-box .aside');
        const statusText = statusBox?.innerText || '';
        const isCompleted = this.checkCompletionStatus(statusBox, statusText);

        if (isCompleted) {
          this.panel.log(`✅ ${title} 已完成，跳过`);
          this.panel.track({ id: `v2-${this.outside}-${idx}`, kind: tagText === '音频' ? 'audio' : 'video', title, status: 'done', detail: '已完成' });
          idx++;
          this.updateProgress(this.outside, idx);
          continue;
        }

        if (tagText === '音频') {
          idx = await this.playAudioItem(item, title, idx);
        } else if (tagHref.includes('shipin')) {
          idx = await this.playVideoItem(item, title, idx);
        } else if (tagHref.includes('tuwen') || tagHref.includes('taolun')) {
          idx = await this.autoCommentItem(item, tagHref.includes('tuwen') ? '图文' : '讨论', idx);
        } else if (tagHref.includes('zuoye')) {
          idx = await this.handleHomework(item, idx);
        } else {
          this.panel.log(`类型未知，已跳过：${title}`);
          idx++;
          this.updateProgress(this.outside, idx);
        }
        if (this.shouldStop) return;
      }
      this.updateProgress(this.outside + 1, 0);
      const batchTitle = course.querySelector('h2')?.innerText?.trim() || '批量内容';
      this.panel.track({ id: `v2-${this.outside}`, kind: 'course', title: batchTitle, status: 'done', detail: '这一组已处理' });
      await Utils.sleep(1000);
    }

    async playAudioItem(item, title, idx) {
      this.panel.log(`开始播放音频：${title}`);
      this.panel.track({ id: `v2-${this.outside}-${idx}`, kind: 'audio', title, status: 'doing' });
      item.click();
      if (await this.waitForExternalHandoff()) return idx;
      await Utils.sleep(2500);
      Player.applyMediaDefault(document.querySelector('audio'));
      const progressNode = document.querySelector('.progress-wrap')?.querySelector('.text');
      const done = await Utils.poll(() => {
        Utils.dismissPopups();
        return Utils.isMarkedDone(progressNode?.innerHTML);
      }, { interval: 3000, timeout: await Utils.getDDL() });
      if (!done) this.panel.log(`${title} 等待后仍未显示已完成，进入下一项`);
      this.panel.log(`${title} 播放完成`);
      this.panel.track({ id: `v2-${this.outside}-${idx}`, kind: 'audio', title, status: 'done', detail: done ? '播放结束' : '未显示已完成，已继续' });
      idx++;
      this.updateProgress(this.outside, idx);
      history.back();
      await Utils.sleep(1500);
      return idx;
    }

    async playVideoItem(item, title, idx) {
      this.panel.log(`开始播放视频：${title}`);
      this.panel.track({ id: `v2-${this.outside}-${idx}`, kind: 'video', title, status: 'doing' });
      item.click();
      if (await this.waitForExternalHandoff()) return idx;
      await Utils.sleep(2500);
      Player.applySpeed();
      Player.mute();
      const video = document.querySelector('video');
      const stopObserve = Player.observePause(video);
      const progressNode = document.querySelector('.progress-wrap')?.querySelector('.text');
      const done = await Utils.poll(() => {
        Utils.dismissPopups();
        return Utils.isMarkedDone(progressNode?.innerHTML);
      }, { interval: 3000, timeout: await Utils.getDDL() });
      stopObserve();
      if (!done) this.panel.log(`${title} 等待后仍未显示已完成，进入下一项`);
      this.panel.log(`${title} 播放完成`);
      this.panel.track({ id: `v2-${this.outside}-${idx}`, kind: 'video', title, status: 'done', detail: done ? '播放结束' : '未显示已完成，已继续' });
      idx++;
      this.updateProgress(this.outside, idx);
      history.back();
      await Utils.sleep(1500);
      return idx;
    }

    async autoCommentItem(item, typeText, idx) {
      this.panel.log(`开始处理${typeText}：${item.querySelector('h2')?.innerText || ''}`);
      item.click();
      await Utils.sleep(1200);

      // 检查是否开启自动评论功能
      const featureFlags = Store.getFeatureConf();
      if (!featureFlags.autoComment) {
        this.panel.log(`${typeText}已查看，但未开启自动回复功能`);
        idx++;
        this.updateProgress(this.outside, idx);
        history.back();
        await Utils.sleep(1000);
        return idx;
      }

      // 开启了自动评论功能，执行评论逻辑
      window.scrollTo(0, document.body.scrollHeight);
      await Utils.sleep(800);
      window.scrollTo(0, 0);
      const commentSelectors = ['#new_discuss .new_discuss_list .cont_detail', '.new_discuss_list dd .cont_detail', '.cont_detail.word-break'];
      let firstComment = '';
      for (let retry = 0; retry < 30 && !firstComment; retry++) {
        for (const sel of commentSelectors) {
          const list = document.querySelectorAll(sel);
          for (const node of list) {
            if (node?.innerText?.trim()) {
              firstComment = node.innerText.trim();
              break;
            }
          }
          if (firstComment) break;
        }
        if (!firstComment) await Utils.sleep(500);
      }
      if (!firstComment) {
        this.panel.log('未找到评论内容，跳过该项');
      } else {
        const input = document.querySelector('.el-textarea__inner');
        if (input) {
          input.value = firstComment;
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
          await Utils.sleep(800);
          const sendBtn = document.querySelector('.el-button.submitComment') ||
            document.querySelector('.publish_discuss .postBtn button') ||
            document.querySelector('.el-button--primary');
          if (sendBtn && !sendBtn.disabled && !sendBtn.classList.contains('is-disabled')) {
            sendBtn.click();
            this.panel.log(`已在${typeText}区发表评论`);
          } else {
            this.panel.log('发送按钮不可用或不存在');
          }
        } else {
          this.panel.log('未找到评论输入框，跳过');
        }
      }
      idx++;
      this.updateProgress(this.outside, idx);
      history.back();
      await Utils.sleep(1000);
      return idx;
    }

    async handleHomework(item, idx) {
      const featureFlags = Store.getFeatureConf();
      if (!featureFlags.autoAI) {
        this.panel.log('已关闭AI自动答题，跳过该项');
        idx++;
        this.updateProgress(this.outside, idx);
        return idx;
      }
      this.panel.log('进入作业，读取题目并请求 AI');
      await Utils.humanClick(item, 1200, 2600);
      await Utils.humanPause(1500, 2800);
      let i = 0;
      const maxRetry = 3; // 最大重试次数
      while (i < 40) {
        const items = document.querySelectorAll('.subject-item.J_order');
        const targetEl = document.querySelector('.item-type')?.parentElement || document.querySelector('.item-body');
        const revealedNow = Solver.revealedResult(targetEl);
        if (revealedNow) {
          this.panel.log(`这题得分 ${revealedNow.score || '0'}，正确答案 ${revealedNow.answer || '见页面'}，进入下一题`);
          const nextItem = items[i + 1];
          if (!nextItem) break;
          await Utils.humanClick(nextItem, 1000, 2400);
          await Utils.humanPause(1200, 2200);
          i++;
          continue;
        }
        const disabled = document.querySelectorAll('.el-button.el-button--info.is-disabled.is-plain');
        if (!targetEl || disabled.length > 0) {
          this.panel.log(`第 ${i + 1} 题已完成，等页面自己进入下一题`);
          const before = (targetEl?.innerText || '').slice(0, 80);
          const moved = await Utils.poll(() => {
            const now = (document.querySelector('.item-body')?.innerText || '').slice(0, 80);
            return now && now !== before;
          }, { interval: 500, timeout: 4000 });
          if (moved) {
            i++;
            continue;
          }
          const nextItem = items[i + 1];
          if (!nextItem) {
            this.panel.log(`所有题目处理完毕，共 ${items.length} 题，准备交卷`);
            break;
          }
          await Utils.humanClick(nextItem, 1000, 2400);
          await Utils.humanPause(1200, 2200);
          i++;
          continue;
        }
        const questionType = Solver.detectQuestionType(targetEl);
        const optionCount = Solver.questionChoices(targetEl).length;
        const captured = await Solver.captureQuestion(targetEl);
        const questionText = captured?.text || '';
        if (captured?.image || questionText.length > 5) {
          this.panel.track({ id: `q-${this.outside}-${idx}-${i}`, kind: 'question', title: `第 ${i + 1} 题`, detail: questionText, status: 'doing' });
          let retryCount = 0;
          let success = false;
          while (retryCount < maxRetry && !success) {
            try {
              if (retryCount > 0) {
                this.panel.log(`🔄 第 ${i + 1} 题重试 ${retryCount}/${maxRetry}...`);
              }
              this.panel.log(`当前是${Solver.questionTypeName(questionType)}`);
              const aiText = await Solver.askAI(questionText, optionCount, captured.image, questionType);
              const before = Solver.questionStem(targetEl);
              await Solver.autoSelectAndSubmit(aiText, targetEl, questionType);
              success = true;
              let shown = null;
              let jumped = false;
              await Utils.poll(() => {
                const body = document.querySelector('.item-body') || targetEl;
                const stem = Solver.questionStem(body);
                if (stem && stem !== before) {
                  jumped = true;
                  return true;
                }
                shown = Solver.revealedResult(body);
                return Boolean(shown);
              }, { interval: 400, timeout: 8000 });
              if (!jumped) {
                if (shown) {
                  await Utils.sleep(1200);
                  const stem = Solver.questionStem(document.querySelector('.item-body') || targetEl);
                  jumped = Boolean(stem && stem !== before);
                }
                if (!jumped) {
                  const nextItem = items[i + 1];
                  this.panel.log(shown
                    ? `这题得分 ${shown.score || '0'}，正确答案 ${shown.answer || '见页面'}，进入下一题`
                    : '这题没有自动进入下一题，改点下一题号');
                  if (nextItem) await Utils.humanClick(nextItem, 1000, 2400);
                }
              }
            } catch (err) {
              retryCount++;
              this.panel.log(`AI 答题失败：${err}`);
              if (retryCount < maxRetry) {
                this.panel.log(`等待 5 秒后重试...`);
                await Utils.sleep(5000);
              } else {
                this.panel.log(`⚠️ 第 ${i + 1} 题重试 ${maxRetry} 次后仍失败，跳过`);
              }
            }
          }
        }
        await Utils.humanPause(2500, 5000);
        i++;
      }
      idx++;
      this.updateProgress(this.outside, idx);
      history.back();
      await Utils.humanPause(1500, 3000);
      return idx;
    }

    async handleClassroom(course) {
      this.panel.log('进入课堂模式...');
      await Utils.humanClick(course, 1000, 2200);
      await Utils.sleep(5000);
      const iframe = document.querySelector('iframe.lesson-report-mobile');
      if (!iframe || !iframe.contentDocument) {
        this.panel.log('未找到课堂 iframe，跳过');
        this.updateProgress(this.outside + 1, 0);
        return;
      }
      const video = iframe.contentDocument.querySelector('video');
      const audio = iframe.contentDocument.querySelector('audio');
      if (video) {
        Player.applyMediaDefault(video);
        await Player.waitForEnd(video);
      }
      if (audio) {
        Player.applyMediaDefault(audio);
        await Player.waitForEnd(audio);
      }
      this.updateProgress(this.outside + 1, 0);
      history.go(-1);
      await Utils.sleep(1200);
    }

    // 等待课件视频播放完毕；播放器被关闭（弹窗关闭/元素销毁）时自动重新打开
    async waitCoursewareVideo() {
      const deadline = await Utils.getDDL();
      const start = Date.now();
      let boundVideo = null;
      let stopObserve = () => { };
      let reopenAttempts = 0;
      let stableDisplay = '';
      try {
        while (Date.now() - start < deadline) {
          Utils.dismissPopups();
          const video = document.querySelector('video');
          const display = document.querySelector('.xt_video_player_current_time_display');
          if (!video) {
            // 播放器被关闭或视频元素被销毁，重新打开视频框
            const videoBox = document.querySelector('.video-box');
            if (videoBox && !videoBox.innerText.includes('已完成')) {
              this.panel.log('播放器被关闭，正在重新打开');
              videoBox.click();
              boundVideo = null;
            }
            reopenAttempts++;
            if (reopenAttempts >= 4) {
              this.panel.log('播放器恢复失败，刷新页面重试');
              location.reload();
              return false;
            }
            await Utils.sleep(2000);
            continue;
          }
          reopenAttempts = 0;
          if (!display) {
            // 播放器加载中，等待渲染
            await Utils.sleep(800);
            continue;
          }
          if (video !== boundVideo) {
            stopObserve();
            Player.applySpeed();
            Player.mute();
            boundVideo = video;
            stopObserve = Player.observePause(video);
            stableDisplay = '';
          }
          Player.noteDuration(video);
          const times = (display.innerText || '').trim();
          const [nowTime, totalTime] = times.split(' / ').map(text => text?.trim());
          // 连续两次读到相同的非零结束时间，避免 00:00 / 00:00 被当成播完
          if (Player.isDisplayFinished(nowTime, totalTime)) {
            if (stableDisplay === times) return true;
            stableDisplay = times;
          } else {
            stableDisplay = '';
          }
          await Utils.sleep(800);
        }
        return false;
      } finally {
        stopObserve();
      }
    }

    async handleCourseware(course) {
      const tableData = course.parentNode?.parentNode?.parentNode?.__vue__?.tableData;
      const deadlinePassed = (tableData?.deadline || tableData?.end) ? (tableData.deadline < Date.now() || tableData.end < Date.now()) : false;
      if (deadlinePassed) {
        this.panel.log(`${course.querySelector('h2')?.innerText || '课件'} 已结课，跳过`);
        this.updateProgress(this.outside + 1, 0);
        return;
      }
      await Utils.humanClick(course, 1000, 2200);
      await Utils.humanPause(2000, 3500);

      // 检测"查看课件"按钮（课件概况页专用）
      const checkBtn = document.querySelector('.ppt_img_box .check') || document.querySelector('p.check');
      if (checkBtn && checkBtn.innerText?.trim() === '查看课件') {
        this.panel.log('检测到"查看课件"按钮，正在点击...');
        await Utils.humanClick(checkBtn, 900, 1800);
        await Utils.humanPause(1500, 2800);
      }
      const classType = document.querySelector('.el-card__header')?.innerText || '';
      const className = document.querySelector('.dialog-header')?.firstElementChild?.innerText || '课件';
      if (classType.includes('PPT')) {
        const slides = document.querySelector('.swiper-wrapper')?.children || [];
        this.panel.log(`开始播放 PPT：${className}`);
        for (let i = 0; i < slides.length; i++) {
          await Utils.humanClick(slides[i], 700, 1600);
          this.panel.log(`${className}：第 ${i + 1} 张`);
          await Utils.humanPause(4500, 8000);
        }
        await Utils.sleep(Config.pptInterval);
        const videoBoxes = document.querySelectorAll('.video-box');
        if (videoBoxes?.length) {
          this.panel.log('PPT 中有视频，继续播放');
          for (let i = 0; i < videoBoxes.length; i++) {
            if (videoBoxes[i].innerText === '已完成') {
              this.panel.log(`第 ${i + 1} 个视频已完成，跳过`);
              continue;
            }
            videoBoxes[i].click();
            await Utils.sleep(2000);
            const played = await this.waitCoursewareVideo();
            if (!played) this.panel.log(`第 ${i + 1} 个视频等待后仍未显示已完成，继续后面的内容`);
          }
        }
        this.panel.log(`${className} 已播放完毕`);
      } else {
        const videoBox = document.querySelector('.video-box');
        if (videoBox) {
          videoBox.click();
          await Utils.sleep(1800);
          const played = await this.waitCoursewareVideo();
          if (!played) this.panel.log(`${className} 等待后仍未显示已完成，进入下一项`);
          else this.panel.log(`${className} 视频播放完毕`);
        }
      }
      this.updateProgress(this.outside + 1, 0);
      history.back();
      await Utils.sleep(1000);
    }
  }

  // ---- pro/lms 旧版（仅做转发） ----
  class ProOldRunner {
    constructor(panel) {
      this.panel = panel;
    }
    run() {
      this.panel.log('准备打开新标签页...');
      const leafDetail = document.querySelectorAll('.leaf-detail');
      let classCount = Store.getProClassCount() - 1;
      while (leafDetail[classCount] && !leafDetail[classCount].firstChild.querySelector('i').className.includes('shipin')) {
        classCount++;
        Store.setProClassCount(classCount + 1);
        this.panel.log('课程不属于视频，已跳过');
      }
      leafDetail[classCount]?.click();
    }
  }

  // ---- pro/lms 新版（主要逻辑） ----
  class ProNewRunner {
    constructor(panel) {
      this.panel = panel;
    }
    async run() {
      preventScreenCheck();
      let classCount = Store.getProClassCount();
      while (true) {
        this.panel.log(`准备播放第 ${classCount} 集...`);
        await Utils.sleep(2000);
        const className = document.querySelector('.header-bar')?.firstElementChild?.innerText || '';
        const classType = document.querySelector('.header-bar')?.firstElementChild?.firstElementChild?.getAttribute('class') || '';
        const classStatus = document.querySelector('#app > div.app_index-wrapper > div.wrap > div.viewContainer.heightAbsolutely > div > div > div > div > section.title')?.lastElementChild?.innerText || '';
        let finished = true;
        if (classType.includes('tuwen') && !classStatus.includes('已读')) {
          this.panel.log(`正在阅读：${className}`);
          await Utils.sleep(2000);
        } else if (classType.includes('taolun')) {
          this.panel.log(`讨论区暂不自动发帖，${className}`);
          await Utils.sleep(2000);
        } else if (classType.includes('shipin') && !classStatus.includes('100%')) {
          this.panel.log(`2s 后开始播放：${className}`);
          await Utils.sleep(2000);
          let statusTimer;
          let videoTimer;
          try {
            statusTimer = setInterval(() => {
              const status = document.querySelector('#app > div.app_index-wrapper > div.wrap > div.viewContainer.heightAbsolutely > div > div > div > div > section.title')?.lastElementChild?.innerText || '';
              if (Utils.isMarkedDone(status)) {
                this.panel.log(`${className} 播放完毕`);
                clearInterval(statusTimer);
                statusTimer = null;
              }
            }, 200);

            const videoWaitStart = Date.now();
            videoTimer = setInterval(() => {
              const video = document.querySelector('video');
              if (video) {
                setTimeout(() => {
                  Player.applySpeed();
                  Player.mute();
                  Player.observePause(video);
                }, 2000);
                clearInterval(videoTimer);
                videoTimer = null;
              } else if (Date.now() - videoWaitStart > 20000) {
                location.reload();
              }
            }, 5000);

            await Utils.sleep(8000);
            finished = await Utils.poll(() => {
              const status = document.querySelector('#app > div.app_index-wrapper > div.wrap > div.viewContainer.heightAbsolutely > div > div > div > div > section.title')?.lastElementChild?.innerText || '';
              return Utils.isMarkedDone(status);
            }, { interval: 1000, timeout: await Utils.getDDL() });
          } finally {
            if (statusTimer) clearInterval(statusTimer);
            if (videoTimer) clearInterval(videoTimer);
          }
          if (!finished) this.panel.log(`${className} 等待后仍未显示已完成，进入下一集`);
        } else if (classType.includes('zuoye')) {
          this.panel.log(`进入作业：${className}（暂无自动答题）`);
          await Utils.sleep(2000);
        } else if (classType.includes('kaoshi')) {
          this.panel.log(`进入考试：${className}（不会自动答题）`);
          await Utils.sleep(2000);
        } else if (classType.includes('ketang')) {
          this.panel.log(`进入课堂：${className}（暂无自动功能）`);
          await Utils.sleep(2000);
        } else {
          this.panel.log(`已看过：${className}`);
          await Utils.sleep(2000);
        }
        this.panel.log(`第 ${classCount} 集播放完毕`);
        classCount++;
        Store.setProClassCount(classCount);
        const nextBtn = document.querySelector('.btn-next');
        if (nextBtn) {
          await Utils.humanClick(nextBtn, 1200, 2600);
        } else {
          localStorage.removeItem(Config.storageKeys.proClassCount);
          this.panel.log('课程播放完毕 🎉');
          Store.clearPendingAutoStart();
          this.panel.resetStartButton('开始刷课');
          break;
        }
      }
    }
  }

  // ---- ai-workspace 新版学习空间 ----
  class AiWorkspaceRunner {
    constructor(panel) {
      this.panel = panel;
    }

    getExerciseQuestionLabel(root) {
      const tabs = AiWorkspace.getExerciseQuestionTabs(root);
      const active = tabs.find(tab => /active|current|selected|is-active/.test(tab.className));
      return AiWorkspace.normalizeText(active?.innerText || '');
    }

    // 获取要跳转回去的目标地址
    getReturnUrl() {
      const pending = Store.getPendingAutoStart();
      const route = AiWorkspace.getRoute();
      if (!pending || !route) return '';
      if (pending.classroomId !== route.classroomId) return '';
      console.log(`returnUrl:${pending.returnUrl}`)
      return pending.returnUrl || '';
    }

    async autoSelect() {
      // 进入ai - workspace的方式有两种：可以处理两种不同的逻辑，增加兼容性
      const returnUrl = this.getReturnUrl()
      // 1. 从传统的 v2 - pro / lms 的目录新开标签页进入（开始刷课）的
      if (returnUrl) {
        await this.returnToSource(returnUrl)
      } else {
        // 2. 直接从ai - workspac页面进入（开始刷课）的
        this.panel.log("检测到是从ai - workspac页面点击开始刷课");
        this.source = AiWorkspace.getAllScourse(); // 得到课程列表
        this.activateIndex = Array.from(this.source).findIndex(el => el.firstChild.classList.contains("is-active")) // 现在正在刷第几个（从0开始）
        await this.handleNext(this.activateIndex + 1)
      }
    }

    // 获取父窗口对象 window.opener
    getSourceWindow() {
      try {
        if (!window.opener || window.opener.closed) return null;
        if (window.opener.location.origin !== location.origin) return null;
        return window.opener;
      } catch (_) {
        return null;
      }
    }

    async returnToSource(returnUrl) {
      this.panel.log('媒体播放完成，返回课程目录页继续匹配');
      await Utils.sleep(1200);
      const sourceWindow = this.getSourceWindow();
      console.log(sourceWindow);
      if (sourceWindow) {
        try {
          sourceWindow.location.href = returnUrl;
          sourceWindow.focus();
          window.close();
          return true;
        } catch (e) {
          console.error("跳转父窗口异常", e);
        }
      }
      // if (location.href !== returnUrl) {
      //   location.href = returnUrl;
      // } else {
      //   history.back();
      // }
      // return true;
    }

    async handleMedia(route) {
      const title = AiWorkspace.getActiveLeafTitle() || `${route.type} ${route.leafId}`;
      const stepId = `ai-${route.leafId || title}`;
      this.panel.log(`开始播放：${title}`);
      this.panel.track({ id: stepId, kind: 'video', title, status: 'doing' });
      const ready = await Utils.poll(() => {
        const current = AiWorkspace.getMedia();
        if (!current || current.ended || current.seeking) return false;
        const duration = Number(current.duration || 0);
        return current.readyState >= 2 && Number.isFinite(duration) && duration > 1;
      }, { interval: 400, timeout: 20000 });
      let media = AiWorkspace.getMedia();
      if (!ready || !media) {
        this.panel.log('未找到视频/音频元素，停止当前轮次');
        return false;
      }

      const playbackState = { completed: false };
      const shouldResume = () => !playbackState.completed;
      let stopObserve = () => { };
      if (media.tagName.toLowerCase() === 'video') {
        Player.applySpeed();
        Player.mute();
        stopObserve = Player.observePause(media, shouldResume);
      } else {
        Player.applyMediaDefault(media);
      }
      const stopKeepAlive = AiWorkspace.keepAlive(shouldResume);
      this.panel.log(`已接管播放器：${media.tagName.toLowerCase()}，目标倍速 ${Config.playbackRate}x，静音开启`);
      let boundMedia = null;
      let onEnded = () => { };
      try {
        let startTime = Number(media.currentTime || 0);
        const started = await Utils.poll(() => {
          const currentMedia = AiWorkspace.getMedia();
          if (currentMedia) media = currentMedia;
          if (!media) return false;
          const currentTime = Number(media.currentTime || 0);
          return currentTime > startTime + 0.5 || (!media.paused && media.readyState >= 2 && currentTime > startTime + 0.2);
        }, { interval: 500, timeout: 15000 });
        if (!started) {
          if (Utils.humanCheckMode() === 'skip' && Utils.isHumanCheckVisible()) {
            this.panel.log('检测到人机验证，跳过本节并进入下一项');
            return true;
          }
          this.panel.log('未确认到视频实际开始播放，停止当前轮次');
          return false;
        }
        startTime = Number(media.currentTime || 0);

        let resolveEnded;
        const endedPromise = new Promise(resolve => {
          resolveEnded = resolve;
        });
        onEnded = (event) => {
          const target = event.currentTarget;
          if (!target || !target.isConnected || target !== media) return;
          if (!AiWorkspace.isPlayerDone(target, { startTime, minPlayedDelta: 3 })) return;
          playbackState.completed = true;
          resolveEnded(true);
        };
        const bindEnded = (nextMedia) => {
          if (!nextMedia || boundMedia === nextMedia) return;
          if (boundMedia) boundMedia.removeEventListener('ended', onEnded);
          boundMedia = nextMedia;
          boundMedia.addEventListener('ended', onEnded);
        };
        bindEnded(media);
        const done = await Promise.race([
          endedPromise,
          Utils.poll(() => {
            if (playbackState.completed) return true;
            const currentMedia = AiWorkspace.getMedia();
            if (currentMedia && currentMedia !== media) {
              media = currentMedia;
              const nextTime = Number(media.currentTime || 0);
              if (nextTime + 0.5 < startTime) startTime = nextTime;
              bindEnded(media);
            }
            if (!media || !media.isConnected) return false;
            if (AiWorkspace.isPlayerDone(media, { startTime, minPlayedDelta: 3 })) {
              playbackState.completed = true;
              return true;
            }
            return false;
          }, { interval: 1000, timeout: await Utils.getDDL() })
        ]);
        playbackState.completed = true;
        if (!done) this.panel.log('等待播放完成超时，准备进入下一集');
      } finally {
        if (boundMedia) boundMedia.removeEventListener('ended', onEnded);
        stopObserve();
        stopKeepAlive();
      }

      await this.waitForMarked();
      this.panel.log(`${title} 播放完成`);
      this.panel.track({ id: stepId, kind: 'video', title, status: 'done', detail: '播放结束' });
      return true;
    }

    async waitForMarked() {
      this.panel.log('播放器已到结尾，等待课程显示已完成');
      const marked = await Utils.poll(() => AiWorkspace.isActiveLessonMarked(), { interval: 1000, timeout: 40000 });
      if (!marked) this.panel.log('等待后仍未显示已完成，进入下一集');
      return true;
    }

    async solveExerciseQuestion(root, label = '') {
      const questionRoot = AiWorkspace.getExerciseQuestionBody(root);
      if (!questionRoot) {
        this.panel.log('未找到题目容器，停止当前轮次');
        return false;
      }
      if (AiWorkspace.isExerciseAnswered(questionRoot)) {
        this.panel.log(`${label || '当前题目'} 已完成，跳过`);
        return true;
      }

      const choices = Solver.questionChoices(questionRoot);
      const optionCount = choices.length;
      const questionType = Solver.detectQuestionType(questionRoot);
      if (!optionCount) {
        this.panel.log(`${label || '当前题目'} 未找到选项，跳过`);
        return false;
      }

      const captured = await Solver.captureQuestion(questionRoot);
      const questionText = captured?.text || '';
      if (!captured?.image && questionText.length <= 5) {
        this.panel.log(`${label || '当前题目'} 题目内容过短，跳过`);
        return false;
      }
      const questionId = `q-${label || '题目'}-${Date.now()}`;
      this.panel.track({
        id: questionId,
        kind: 'question',
        title: label || '题目',
        detail: questionText,
        status: 'doing'
      });

      const maxRetry = 3;
      for (let retryCount = 0; retryCount < maxRetry; retryCount++) {
        try {
          if (retryCount > 0) this.panel.log(`${label || '当前题目'} 重试 ${retryCount}/${maxRetry - 1}`);
          this.panel.log(`当前是${Solver.questionTypeName(questionType)}`);
          const aiText = await Solver.askAI(questionText, optionCount, captured.image, questionType);
          await Solver.autoSelectAndSubmit(aiText, questionRoot, questionType);
          await Utils.humanPause(2000, 4500);
          return true;
        } catch (err) {
          this.panel.log(`AI 答题失败：${err}`);
          if (retryCount < maxRetry - 1) await Utils.sleep(5000);
        }
      }
      return false;
    }

    async openNextExerciseQuestion(root, previousStem = '') {
      const currentRoot = AiWorkspace.getExerciseContainer() || root;
      const tabs = AiWorkspace.getExerciseQuestionTabs(currentRoot);
      const activeIndex = tabs.findIndex(tab => /active|current|selected|is-active/.test(tab.className));
      const nextTab = activeIndex >= 0 ? tabs[activeIndex + 1] : null;
      const leftQuestion = () => {
        const body = AiWorkspace.getExerciseQuestionBody(AiWorkspace.getExerciseContainer() || currentRoot);
        const stem = Solver.questionStem(body);
        return Boolean(stem && stem !== previousStem);
      };
      if (nextTab) {
        await Utils.humanClick(nextTab, 800, 1600);
        if (await Utils.poll(leftQuestion, { interval: 400, timeout: 4000 })) return true;
      }
      const nextBtn = AiWorkspace.getExerciseActionButton(AiWorkspace.getExerciseContainer() || currentRoot, /下一题|下一道|下一步/);
      if (!nextBtn) return false;
      await Utils.humanClick(nextBtn, 800, 1600);
      return Utils.poll(leftQuestion, { interval: 400, timeout: 5000 });
    }

    async advanceExerciseQuestion(root, previousFingerprint = '') {
      const currentRoot = AiWorkspace.getExerciseContainer() || root;
      const nextBtn = AiWorkspace.getExerciseActionButton(currentRoot, /下一题|下一道|下一步/);
      if (!nextBtn) return false;
      await Utils.humanClick(nextBtn, 1200, 2800);
      return Utils.poll(() => {
        const latestRoot = AiWorkspace.getExerciseContainer() || currentRoot;
        const questionRoot = AiWorkspace.getExerciseQuestionBody(latestRoot);
        const fingerprint = AiWorkspace.normalizeText(questionRoot?.innerText || '').slice(0, 120);
        return fingerprint && fingerprint !== previousFingerprint;
      }, { interval: 500, timeout: 5000 });
    }

    async handleExercise(route) {
      const featureFlags = Store.getFeatureConf();
      if (!featureFlags.autoAI) {
        this.panel.log('已关闭 AI 自动答题，作业将直接跳过');
        return true;
      }

      const ready = await Utils.poll(() => Boolean(AiWorkspace.getExerciseContainer()), { interval: 500, timeout: 20000 });
      const root = AiWorkspace.getExerciseContainer();
      if (!ready || !root) {
        this.panel.log('未找到作业容器，停止当前轮次');
        return false;
      }

      this.panel.log(`开始处理作业：${AiWorkspace.getActiveLeafTitle() || route.leafId}`);
      let previousFingerprint = '';
      for (let i = 0; i < 40; i++) {
        const currentRoot = AiWorkspace.getExerciseContainer() || root;
        const questionRoot = AiWorkspace.getExerciseQuestionBody(currentRoot);
        const fingerprint = Solver.questionStem(questionRoot);
        if (!fingerprint) break;
        const revealed = Solver.revealedResult(questionRoot);
        if (revealed) {
          this.panel.log(`这题已显示结果，得分 ${revealed.score || '0'}，正确答案 ${revealed.answer || '见页面'}，进入下一题`);
          const opened = await this.openNextExerciseQuestion(currentRoot, fingerprint);
          if (!opened) break;
          continue;
        }
        if (AiWorkspace.isExerciseAnswered(questionRoot)) {
          const opened = await this.openNextExerciseQuestion(currentRoot, fingerprint);
          if (!opened) break;
          continue;
        }
        if (i > 0 && fingerprint === previousFingerprint) break;
        await this.solveExerciseQuestion(currentRoot, `第 ${i + 1} 题`);
        previousFingerprint = fingerprint;
        let shown = null;
        let jumped = false;
        await Utils.poll(() => {
          const latestRoot = AiWorkspace.getExerciseQuestionBody(AiWorkspace.getExerciseContainer() || currentRoot);
          const stem = Solver.questionStem(latestRoot);
          if (stem && stem !== fingerprint) {
            jumped = true;
            return true;
          }
          shown = Solver.revealedResult(latestRoot);
          return Boolean(shown);
        }, { interval: 400, timeout: 8000 });
        if (jumped) continue;
        if (shown) {
          await Utils.sleep(1200);
          const latestRoot = AiWorkspace.getExerciseQuestionBody(AiWorkspace.getExerciseContainer() || currentRoot);
          if (Solver.questionStem(latestRoot) !== fingerprint) continue;
          this.panel.log(`这题得分 ${shown.score || '0'}，正确答案 ${shown.answer || '见页面'}，进入下一题`);
        } else {
          this.panel.log('这题没有自动进入下一题，改点下一题');
        }
        const opened = await this.openNextExerciseQuestion(currentRoot, fingerprint);
        if (!opened) break;
      }
      return true;
    }

    async handleForum(route) {
      const title = AiWorkspace.getActiveLeafTitle() || '讨论';
      const stepId = `forum-${route.leafId || title}`;
      this.panel.log(`开始处理讨论：${title}`);
      this.panel.track({ id: stepId, kind: 'forum', title, status: 'doing', detail: '读取讨论题' });
      await Utils.poll(() => AiWorkspace.forumStatus() || AiWorkspace.forumTopic() || AiWorkspace.findForumComposer(), { interval: 500, timeout: 12000 });
      const status = AiWorkspace.forumStatus();
      if (status === '已发言' || status === '已完成') {
        this.panel.log(`${title} 已经发过言，跳过`);
        this.panel.track({ id: stepId, kind: 'forum', title, status: 'done', detail: status });
        return true;
      }
      if (!Store.getFeatureConf().autoComment) {
        this.panel.log('未开启「批量区图文和讨论自动回复」，讨论已跳过。要自动发言请在 AI 配置里打开这个开关');
        this.panel.track({ id: stepId, kind: 'forum', title, status: 'skip', detail: '未开启自动回复' });
        return true;
      }
      let composer = AiWorkspace.findForumComposer();
      if (!composer) {
        const tab = [...document.querySelectorAll('button, [role="tab"], a, span, div')].find(el => {
          const text = (el.innerText || '').trim();
          return /^讨论区/.test(text) && text.length < 16 && AiWorkspace.isVisibleElement(el);
        });
        if (tab) {
          tab.click();
          await Utils.sleep(800);
          composer = AiWorkspace.findForumComposer();
        }
      }
      const topic = AiWorkspace.forumTopic();
      if (!topic) {
        this.panel.log('没有读到讨论题，跳过');
        this.panel.track({ id: stepId, kind: 'forum', title, status: 'skip', detail: '没有读到题目' });
        return true;
      }
      if (!composer) {
        this.panel.log('没有找到发言框，跳过');
        this.panel.track({ id: stepId, kind: 'forum', title, status: 'skip', detail: '没有发言框' });
        return true;
      }
      this.panel.track({ id: stepId, kind: 'forum', title, status: 'doing', detail: topic });
      this.panel.log(`读到的讨论题：${topic.slice(0, 80)}`);
      let reply = '';
      try {
        reply = await Solver.requestChat(
          `下面是讨论题原文。回复必须完成题目里的任务，不要换成别的话题。题目点名的方法、概念要在回复里出现，并按题目要求举一个具体例子。用第一人称，120到180个字。不要标题，不要序号，不要引号。\n讨论题：\n${topic}`,
          '你是在课程讨论区发言的大学生。只根据讨论题原文作答，不回答题目没问的内容。',
          Solver.answerConf(),
          320
        );
      } catch (err) {
        this.panel.log(`讨论回复生成失败：${err.message || err}`);
        this.panel.track({ id: stepId, kind: 'forum', title, status: 'skip', detail: '回复生成失败' });
        return true;
      }
      reply = String(reply || '').replace(/```[\s\S]*?```/g, '').replace(/^回复[：:]\s*/, '').replace(/\n+/g, '').trim();
      if (reply.length > 180) reply = reply.slice(0, 180);
      if (reply.length < 8) {
        this.panel.log('模型没有写出可用回复，跳过');
        this.panel.track({ id: stepId, kind: 'forum', title, status: 'skip', detail: '回复过短' });
        return true;
      }
      await Utils.humanPause(900, 1800);
      AiWorkspace.setFieldValue(composer, reply);
      await Utils.humanPause(700, 1400);
      const sendBtn = AiWorkspace.findForumSendButton(composer);
      const sendable = sendBtn && !sendBtn.disabled && sendBtn.getAttribute('aria-disabled') !== 'true' && !sendBtn.classList.contains('is-disabled');
      if (sendable) {
        await Utils.humanClick(sendBtn, 600, 1400);
      } else {
        composer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
      }
      const posted = await Utils.poll(() => {
        const next = AiWorkspace.forumStatus();
        return next === '已发言' || next === '已完成';
      }, { interval: 500, timeout: 12000 });
      if (!posted) {
        this.panel.log('已尝试发送，页面仍显示未发言');
        this.panel.track({ id: stepId, kind: 'forum', title, status: 'skip', detail: reply });
        return true;
      }
      this.panel.log(`讨论已发言：${reply.slice(0, 40)}`);
      this.panel.track({ id: stepId, kind: 'forum', title, status: 'done', detail: reply });
      await Utils.humanPause(1200, 2200);
      return true;
    }

    // 直接在ai-workspace页面处理课程的逻辑
    async handleNext(count) {
      if (count >= this.source.length) {
        this.panel.log('课程刷完啦 🎉');
        this.panel.resetStartButton('刷完啦~');
        Store.clearPendingAutoStart();
        return;
      }
      await Utils.humanPause(1500, 3500);
      this.source[count].firstChild.click();
      await Utils.sleep(2000);
      const switched = await Utils.poll(() => {
        const media = AiWorkspace.getMedia();
        if (!media || media.ended || media.seeking) return false;
        const duration = Number(media.duration || 0);
        return media.readyState >= 2 && Number.isFinite(duration) && duration > 1;
      }, { interval: 400, timeout: 20000 });
      if (!switched) this.panel.log('下一集播放器还没就绪，仍尝试继续');
      await this.run(false)
    }

    async run(preventScreenCheckSwitch = true) {
      // 仅开启一次防切屏
      if (preventScreenCheckSwitch) preventScreenCheck();
      const route = AiWorkspace.getRoute();
      if (!route) {
        this.panel.log('当前页面已离开 ai-workspace/lms-graph');
        return;
      }
      if (!route.leafId) {
        this.panel.log('未能识别当前知识点');
        return;
      }
      let ok = false;
      if (route.type === 'video' || route.type === 'audio') {
        ok = await this.handleMedia(route);
      } else if (route.type === 'exercise') {
        ok = await this.handleExercise(route);
      } else if (route.type === 'forum' || route.type === 'discussion') {
        ok = await this.handleForum(route);
      } else {
        this.panel.log(`当前类型为 ${route.type}，当前暂不自动处理此类型，自动跳过`);
        await Utils.sleep(2000);
        ok = true;
      }
      if (!ok) {
        this.panel.warn('当前内容未播放完成，停留在本节');
        return;
      }
      await this.autoSelect()
    }
  }

  // ---- 路由 ----
  function start() {
    // ---- ai-workspace获取课程根目录信息并保存（处理完一个课程重定向到根目录） ----
    const classroomId = Utils.getCurrentClassroomId();
    const returnUrl = Utils.returnUrl()
    Store.setPendingAutoStart(classroomId, returnUrl);
    const aiRoute = AiWorkspace.getRoute();
    if (aiRoute) {
      panel.log(`正在匹配处理逻辑：ai-workspace/lms-graph/${aiRoute.type}`);
      new AiWorkspaceRunner(panel).run();
      return;
    }
    // ---- ai-workspace end
    const url = location.host;
    const path = location.pathname.split('/');
    const matchURL = `${url}${path[0]}/${path[1]}/${path[2]}`;
    panel.log(`正在匹配处理逻辑：${matchURL}`);
    if (matchURL.includes('yuketang.cn/v2/web') || matchURL.includes('gdufemooc.cn/v2/web')) {
      new V2Runner(panel).run();
    } else if (matchURL.includes('yuketang.cn/pro/lms') || matchURL.includes('gdufemooc.cn/pro/lms')) {
      if (document.querySelector('.btn-next')) {
        new ProNewRunner(panel).run();
      } else {
        new ProOldRunner(panel).run();
      }
    } else {
      panel.resetStartButton('开始刷课');
      panel.log('当前页面非刷课页面，应匹配 */v2/web/*、*/pro/lms/* 或 */ai-workspace/lms-graph/*');
    }
  }

  // ---- 启动 ----
  async function boot() {
    if (Utils.inIframe()) return;
    await Utils.waitForMountTarget();
    try {
      panel = createPanel();
      panel.log(`雨课堂刷课助手 v${Config.version} 已加载`);
      panel.setStartHandler(start);
      const pendingAutoStart = Store.getPendingAutoStart();
      const currentClassroomId = Utils.getCurrentClassroomId();
      if (
        pendingAutoStart
        && Utils.isSupportedLearningPage()
        && currentClassroomId
        && pendingAutoStart.classroomId === currentClassroomId
      ) {
        panel.log(`检测到跨页面跳转，自动恢复刷课：课堂 ${currentClassroomId}`);
        setTimeout(() => panel.start(), 1200);
      }
    } catch (err) {
      console.error('面板初始化失败:', err);
    }
  }

  boot();

})();
