(() => {
  const replacements = {
    "content-it": [
      ["Dati di utilizzo:", "<span class='legal-strong'>Analytics dettagliate:</span> solo dopo consenso esplicito registriamo indirizzo IP, browser e versione, sistema operativo, tipo di dispositivo, pagine visitate, referrer, lingua, fuso orario e un identificatore casuale del visitatore. Non utilizziamo questi dati per pubblicità e non li vendiamo."],
      ["Analytics:", "<span class='legal-strong'>Conservazione analytics:</span> non è prevista una cancellazione automatica. I dati restano conservati finché il consenso rimane attivo; vengono cancellati quando revochi dal pulsante Privacy o presenti una richiesta di cancellazione."],
      ["Lingua e identificatore analytics", "Lingua e scelta privacy sono salvate in <span class='legal-strong'>localStorage</span>. L’identificatore analytics casuale viene creato soltanto dopo il consenso e rimosso alla revoca; la revoca richiede anche la cancellazione degli eventi associati dal server."],
    ],
    "content-en": [
      ["Usage data:", "<span class='legal-strong'>Detailed analytics:</span> only after explicit consent we record IP address, browser and version, operating system, device type, visited pages, referrer, language, time zone and a random visitor identifier. We do not sell this data or use it for advertising."],
      ["IP logs:", "<span class='legal-strong'>Analytics retention:</span> there is no automatic expiry. Data is stored while consent remains active and is erased when you withdraw through the Privacy button or submit an erasure request."],
      ["Language localization is saved", "Language and the privacy choice are stored in <span class='legal-strong'>localStorage</span>. A random analytics identifier is created only after consent and removed on withdrawal; withdrawal also requests deletion of associated server events."],
    ],
    "content-ru": [
      ["Данные использования:", "<span class='legal-strong'>Подробная аналитика:</span> только после явного согласия мы сохраняем IP-адрес, браузер и его версию, операционную систему, тип устройства, посещённые страницы, источник перехода, язык, часовой пояс и случайный идентификатор посетителя. Данные не продаются и не используются для рекламы."],
      ["IP логи:", "<span class='legal-strong'>Срок хранения аналитики:</span> автоматического удаления нет. Данные хранятся, пока действует согласие, и удаляются при отзыве через кнопку Privacy или по запросу на удаление."],
      ["Локализация языка сохраняется", "Язык и выбор конфиденциальности сохраняются в <span class='legal-strong'>localStorage</span>. Случайный идентификатор аналитики создаётся только после согласия и удаляется при его отзыве вместе с соответствующими событиями на сервере."],
    ],
    "content-zh": [
      ["使用数据：", "<span class='legal-strong'>详细分析：</span>仅在明确同意后，我们才会保存 IP 地址、浏览器及版本、操作系统、设备类型、访问页面、来源、语言、时区和随机访客标识符。数据不会出售，也不会用于广告。"],
      ["IP日志：", "<span class='legal-strong'>分析数据保留：</span>不会自动到期。数据在同意有效期间持续保存，并在通过 Privacy 按钮撤回同意或提出删除请求时删除。"],
      ["语言本地化保存在", "语言和隐私选择保存在 <span class='legal-strong'>localStorage</span>。随机分析标识符仅在同意后创建；撤回时会删除该标识符，并请求服务器删除相关事件。"],
    ],
  };

  for (const [containerId, entries] of Object.entries(replacements)) {
    const container = document.getElementById(containerId);
    if (!container) continue;
    for (const [needle, html] of entries) {
      const paragraph = [...container.querySelectorAll("p.legal-p")].find((item) => item.textContent.includes(needle));
      if (paragraph) paragraph.innerHTML = html;
    }
  }
})();
