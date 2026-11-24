import assert from 'node:assert/strict'

/**
 * 角色配音：标记协议与解析器。纯逻辑，不涉及界面。
 * 对应 docs/role-voice-plan.md 第 4.2 节的每一种情况。
 */
export const runRoleVoiceCases = async (run) => {
  await run('ASR retries the same recording and adds the Chinese transcript to the draft', async (page) => {
    const recordings = []
    await page.route('**/v1/tools/asr', async (route) => {
      const body = route.request().postDataBuffer()
      const start = body.indexOf('RIFF')
      assert.ok(start >= 0, 'upload contains a WAV file')
      const end = start + body.readUInt32LE(start + 4) + 8
      recordings.push(body.subarray(start, end))
      const failed = recordings.length === 1
      await route.fulfill({
        status: failed ? 503 : 200,
        headers: { 'access-control-allow-origin': '*' },
        contentType: 'application/json',
        body: failed ? '{}' : '{"text":"语音转写成功。"}',
      })
    })
    await page.evaluate(() => {
      window.__audit.settings.setApiKey('asr-fixture')
      const counts = { captures: 0, stopped: 0, samples: 0 }
      window.__microphoneFixture = counts
      const track = new EventTarget()
      track.stop = () => counts.stopped++
      Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { value: async () => {
        counts.captures++
        return { getTracks: () => [track], getAudioTracks: () => [track] }
      } })
      const createNode = () => ({ connect() {}, disconnect() {} })
      window.AudioContext = class {
        state = 'running'
        sampleRate = 48000
        destination = {}
        createMediaStreamSource() { return createNode() }
        createAnalyser() {
          return {
            ...createNode(), context: this, frequencyBinCount: 256,
            getFloatFrequencyData(values) { values.fill(-45) },
          }
        }
        createScriptProcessor() {
          const processor = createNode()
          setTimeout(() => {
            processor.onaudioprocess?.({
              inputBuffer: { getChannelData: () => new Float32Array(4096).fill(0.15) },
            })
            counts.samples++
          }, 80)
          return processor
        }
        close() { this.state = 'closed'; return Promise.resolve() }
      }
    })
    const composer = page.getByTestId('chat-composer')
    const input = composer.locator('textarea')
    await input.fill('补充一下，')
    await input.press('End')
    await composer.getByRole('button', { name: '语音输入', exact: true }).click()
    await page.waitForFunction(() => window.__microphoneFixture.samples === 1)
    if (process.env.FREESEEK_SPEECH_PREVIEWS) {
      await page.screenshot({ path: 'tmp/regression/voice-capture-zh.png', animations: 'disabled' })
    }
    await composer.getByRole('button', { name: '结束录音并转写' }).click()
    const retry = composer.getByRole('button', { name: '重试转写' })
    await retry.waitFor()
    await composer.getByRole('button', { name: '丢弃录音' }).waitFor()
    assert.equal(await input.inputValue(), '补充一下，', 'failure keeps the draft')
    if (process.env.FREESEEK_SPEECH_PREVIEWS) {
      await page.screenshot({ path: 'tmp/regression/voice-retry-zh.png', animations: 'disabled' })
    }
    await retry.click()
    await page.waitForFunction(() => document.querySelector('[data-testid="chat-composer"] textarea')?.value === '补充一下，语音转写成功。')
    assert.equal(recordings.length, 2)
    assert.deepEqual(recordings[0], recordings[1], 'retry uploads the same WAV audio')
    assert.equal(recordings[0].readUInt32LE(24), 16000, 'native capture was resampled for ASR')
    assert.deepEqual(await page.evaluate(() => window.__microphoneFixture), { captures: 1, stopped: 1, samples: 1 })
  })

  const parse = async (page, text, existing = [], options) =>
    page.evaluate(
      async ({ text, existing, options }) => {
        const m = window.__audit.roleMarkers
        const result = m.parseRoleMarkers(text, existing, { now: 1000, ...options })
        return {
          ...result,
          // Map/Set 不方便跨边界，这里不需要
        }
      },
      { text, existing, options }
    )

  await run(
    'role markers: a reply without markers parses to plain text and no segments',
    async (page) => {
      const r = await parse(page, '今天天气不错。\n\n适合出去走走。')
      assert.equal(r.plain, '今天天气不错。\n\n适合出去走走。')
      assert.equal(r.segments.length, 0)
      assert.equal(r.newRoles.length, 0)
    }
  )

  await run(
    'role markers: first appearance creates a role with aliases, voice and nature',
    async (page) => {
      const r = await parse(
        page,
        '⟦新角色：林黛玉｜别名：林妹妹、颦儿｜音色：茉莉｜性格：多愁善感，说话轻柔｜重要性：主角⟧你别管我。'
      )
      assert.equal(r.newRoles.length, 1)
      const role = r.newRoles[0]
      assert.equal(role.name, '林黛玉')
      assert.deepEqual(role.aliases, ['林妹妹', '颦儿'])
      assert.equal(role.preset, '茉莉')
      assert.equal(role.description, undefined)
      assert.equal(role.nature, '多愁善感，说话轻柔')
      assert.equal(role.importance, 'lead')
      assert.equal(role.source, 'model')
      assert.equal(r.segments.length, 1)
      assert.equal(r.segments[0].roleId, role.id)
      assert.equal(r.segments[0].text, '你别管我。')
      assert.equal(r.plain, '你别管我。')
    }
  )

  await run('role markers preserve literal tags inside Markdown code', async (page) => {
    const tick = String.fromCharCode(96)
    const code = ['解释 ' + tick + '⟦新角色：示例⟧' + tick, '', '~~~text', '⟦新角色：代码⟧', '~~~'].join('\n')
    const input = code + '\n\n⟦旁白⟧故事开始。'
    const r = await parse(page, input)
    assert.equal(r.plain, code + '\n\n故事开始。')
    assert.deepEqual(r.newRoles.map(({ name }) => name), ['旁白'])
    const visible = await page.evaluate((value) => window.__audit.roleMarkers.stripRoleMarkers(value), input)
    assert.equal(visible, r.plain)
  })

  await run('role markers understand the English dialogue protocol and full aliases', async (page) => {
    const input =
      '「New character：Lin Daiyu｜Aliases：Lin Meimei, Pin’er｜Voice：Chloe｜Nature：gentle｜Importance：lead」\n' +
      'I heard you.\n\n「Lin Meimei｜Tone: surprised」\nReally?\n\n' +
      '「Narrator｜Voice：Milo｜Tone：calm」\nShe waited.'
    const result = await parse(page, input)
    const [lead, narrator] = result.newRoles
    assert.deepEqual(result.newRoles.map(({ name }) => name), ['Lin Daiyu', 'Narrator'])
    assert.deepEqual(lead.aliases, ['Lin Meimei', 'Pin’er'])
    assert.equal(lead.preset, 'Chloe')
    assert.equal(lead.importance, 'lead')
    assert.equal(narrator.importance, 'supporting')
    assert.equal(result.segments[1].roleId, lead.id)
    assert.equal(result.segments[1].tone, 'surprised')
    assert.doesNotMatch(result.plain, /Voice|Tone|Aliases/)
  })

  await run(
    'role markers: a described voice is kept as description for leads and supporting roles',
    async (page) => {
      const r = await parse(
        page,
        '⟦新角色：王熙凤｜音色：泼辣爽利的中年女声，语速快｜性格：精明泼辣｜重要性：次要⟧我来迟了！'
      )
      const role = r.newRoles[0]
      assert.equal(role.description, '泼辣爽利的中年女声，语速快')
      assert.equal(role.preset, undefined)
      assert.equal(role.importance, 'supporting')
    }
  )

  await run(
    'role markers: narrator and extra roles are forced onto preset voices',
    async (page) => {
      const r = await parse(
        page,
        '⟦新角色：旁白｜音色：随便写的描述｜重要性：次要⟧窗外竹影摇曳。' +
          '⟦新角色：店小二｜音色：随便写的描述｜重要性：路人⟧客官里边请。'
      )
      const [narrator, waiter] = r.newRoles
      assert.equal(narrator.name, '旁白')
      assert.equal(narrator.preset, '白桦')
      assert.equal(narrator.description, undefined)
      assert.equal(narrator.nature, '冷静客观')
      assert.equal(waiter.importance, 'extra')
      assert.equal(waiter.preset, '苏打')
      assert.notEqual(narrator.preset, waiter.preset, 'by default walk-ons do not sound like the narrator')
      assert.equal(waiter.description, undefined)
      // 各自可配：旁白和路人用不同的音色
      const r2 = await parse(page, '⟦新角色：旁白⟧x', [], { narratorVoice: '茉莉', extraVoice: '苏打' })
      assert.equal(r2.newRoles[0].preset, '茉莉')
      const r3 = await parse(page, '⟦新角色：路人甲｜重要性：路人⟧y', [], { extraVoice: '苏打' })
      assert.equal(r3.newRoles[0].preset, '苏打')
    }
  )

  await run(
    'role markers: a known role keeps its locked voice; only tone is taken from later markers',
    async (page) => {
      const existing = [
        {
          id: 'r1',
          name: '林黛玉',
          aliases: ['林妹妹'],
          preset: '茉莉',
          nature: '多愁善感，说话轻柔',
          importance: 'lead',
          source: 'user',
          createdAt: 1,
        },
      ]
      const r = await parse(
        page,
        '⟦新角色：林黛玉｜音色：冰糖｜性格：完全不同的性格｜重要性：主角⟧台词。' +
          '⟦林妹妹｜语气：委屈，声音发颤⟧你别管我。',
        existing
      )
      assert.equal(r.newRoles.length, 0, 'must not create a duplicate')
      assert.equal(r.segments.length, 2)
      assert.equal(r.segments[0].roleId, 'r1')
      assert.equal(r.segments[1].roleId, 'r1', 'alias resolves to the same role')
      assert.equal(r.segments[1].tone, '委屈，声音发颤')
      assert.equal(r.promotions.length, 0, 'lead cannot be promoted further')
    }
  )

  await run(
    'role markers: a role is promoted when the model later gives it more weight, never demoted',
    async (page) => {
      const extra = {
        id: 'r2',
        name: '袭人',
        aliases: [],
        preset: '白桦',
        nature: '',
        importance: 'extra',
        source: 'model',
        createdAt: 1,
      }
      const up = await parse(page, '⟦新角色：袭人｜重要性：次要⟧是。', [extra])
      assert.equal(up.newRoles.length, 0)
      assert.deepEqual(up.promotions, [{ roleId: 'r2', to: 'supporting' }])
      const lead = { ...extra, importance: 'lead' }
      const down = await parse(page, '⟦新角色：袭人｜重要性：路人⟧是。', [lead])
      assert.equal(down.promotions.length, 0, 'never demoted')
    }
  )

  await run(
    'role markers: new aliases declared for an existing role are collected, voice untouched',
    async (page) => {
      const existing = [
        { id: 'r1', name: '林黛玉', aliases: [], preset: '茉莉', nature: '', importance: 'lead', source: 'model', createdAt: 1 },
      ]
      const r = await parse(page, '⟦新角色：林黛玉｜别名：颦儿、颦颦｜音色：冰糖⟧x', existing)
      assert.deepEqual(r.aliasAdditions, [{ roleId: 'r1', aliases: ['颦儿', '颦颦'] }])
      assert.equal(r.newRoles.length, 0)
    }
  )

  await run(
    'role markers: a bare name that is not in the table is created on the spot and still gets voiced',
    async (page) => {
      // 实测模型经常只写「⟦旁白⟧」而不写「新角色」声明；不补建的话整个功能都失效
      const r = await parse(page, '⟦晴雯｜语气：倔强⟧我不过是个丫头。')
      assert.deepEqual(r.unknownNames, ['晴雯'], 'reported so the caller can log it')
      assert.equal(r.newRoles.length, 1)
      assert.equal(r.newRoles[0].name, '晴雯')
      assert.equal(r.newRoles[0].importance, 'extra', 'a bare name is a walk-on by default')
      assert.equal(r.newRoles[0].preset, '苏打', 'walk-ons share the extra voice')
      assert.equal(r.segments.length, 1, 'it is still read aloud')
      assert.equal(r.segments[0].tone, '倔强')
      assert.equal(r.plain, '我不过是个丫头。', 'text still renders')
    }
  )

  await run(
    'role markers: the narrator named without a declaration becomes a supporting role with the narrator voice',
    async (page) => {
      const r = await parse(page, '⟦旁白｜语气：沉静平缓⟧黛玉拜见过外祖母。', [], { narratorVoice: '茉莉' })
      assert.equal(r.newRoles.length, 1)
      assert.equal(r.newRoles[0].name, '旁白')
      assert.equal(r.newRoles[0].importance, 'supporting')
      assert.equal(r.newRoles[0].preset, '茉莉')
      assert.equal(r.segments[0].text, '黛玉拜见过外祖母。')
    }
  )

  await run(
    'role markers: the mismatched closing bracket the real model produces is understood and stripped',
    async (page) => {
      // 实测 mimo 输出：开 ⟦、闭 〕。旧实现只认 ⟧，导致标记留在正文里、一段都解析不出
      const real = '⟦旁白｜语气：沉静平缓〕黛玉一一拜见过外祖母与舅母姊妹，方欲与众人叙话，忽听得后院中一阵笑声。'
      const r = await parse(page, real)
      assert.equal(r.newRoles.length, 1, 'the tag is recognized despite the mismatched closer')
      assert.equal(r.newRoles[0].name, '旁白')
      assert.equal(r.segments.length, 1)
      assert.equal(r.segments[0].text.startsWith('黛玉一一拜见过'), true)
      assert.equal(r.plain.includes('⟦'), false)
      assert.equal(r.plain.includes('〕'), false)
      assert.equal(r.plain.startsWith('黛玉一一拜见过'), true)

      // 其余几种收尾写法也要认
      for (const closer of ['〕', '】', '］', ']', '⟧']) {
        const text = `⟦旁白｜语气：平静${closer}风过无声。`
        const stripped = await page.evaluate(
          (value) => window.__audit.roleMarkers.stripRoleMarkers(value),
          text
        )
        assert.equal(stripped, '风过无声。', `closer ${closer} must be stripped`)
      }
    }
  )

  await run(
    'role markers: tags written as bare lines (no brackets) are recognized and stripped',
    async (page) => {
      // 实测：提示词要求用「」时，模型干脆连括号都不写
      const real = [
        '旁白｜音色：茉莉｜语气：平缓铺垫',
        '黛玉一路进了贾府，先拜见了邢夫人、王夫人。',
        '',
        '新角色：林黛玉｜别名：林妹妹、颦儿｜音色：茉莉｜性格：多愁善感｜重要性：主角',
        '黛玉暗自诧异：「这些人个个皆敛声屏气。」',
        '',
        '王熙凤｜语气：朗快爽利',
        '「我来迟了，不曾迎接远客！」',
      ].join('\n')
      const r = await parse(page, real)
      assert.equal(r.newRoles.length, 3, 'narrator, Daiyu and Xifeng all registered')
      assert.equal(r.newRoles[0].name, '旁白')
      assert.equal(r.newRoles[0].preset, '茉莉', 'declared voice respected')
      assert.equal(r.newRoles[0].importance, 'supporting')
      assert.equal(r.newRoles[1].name, '林黛玉')
      assert.deepEqual(r.newRoles[1].aliases, ['林妹妹', '颦儿'])
      assert.equal(r.newRoles[1].importance, 'lead')
      assert.equal(r.newRoles[2].name, '王熙凤')
      assert.equal(r.newRoles[2].importance, 'extra', 'no importance declared means a walk-on')
      assert.equal(r.segments.length, 3)
      assert.equal(r.segments[2].text, '「我来迟了，不曾迎接远客！」', 'dialogue after the tag line is the speech')
      assert.equal(r.plain.includes('｜'), false, 'tag lines gone')
      assert.equal(r.plain.includes('语气'), false)
      assert.equal(r.plain.includes('黛玉一路进了贾府'), true, 'prose kept')
      assert.equal(r.plain.includes('这些人个个皆敛声屏气'), true, 'quoted dialogue kept')
    }
  )

  await run(
    'role markers: a prose line that happens to contain a pipe is not mistaken for a tag',
    async (page) => {
      const text = '公式里 A｜B 表示一种映射关系。\n\n他说：「你好。」'
      const stripped = await page.evaluate(
        (value) => window.__audit.roleMarkers.stripRoleMarkers(value),
        text
      )
      assert.equal(stripped, text, 'no known field keywords means it is prose')
      const parsed = await parse(page, text)
      assert.equal(parsed.newRoles.length, 0)
      assert.equal(parsed.segments.length, 0)
    }
  )
  await run(
    'role markers: the square-bracket form is recognized, but ordinary emphasis in prose is left alone',
    async (page) => {
      const tagged = await parse(page, '【新角色：林黛玉｜音色：茉莉｜重要性：主角】你别管我。')
      assert.equal(tagged.newRoles.length, 1)
      assert.equal(tagged.newRoles[0].name, '林黛玉')
      assert.equal(tagged.plain, '你别管我。')

      // 【注意】这类正常强调不能被当成标注删掉
      const plain = '【注意】这段是普通正文。'
      const stripped = await page.evaluate(
        (value) => window.__audit.roleMarkers.stripRoleMarkers(value),
        plain
      )
      assert.equal(stripped, plain)
      const parsed = await parse(page, plain)
      assert.equal(parsed.newRoles.length, 0)
      assert.equal(parsed.plain, plain)

      // Markdown 链接不能被破坏
      const link = '见 [文档](https://example.com) 说明。'
      const linkStripped = await page.evaluate(
        (value) => window.__audit.roleMarkers.stripRoleMarkers(value),
        link
      )
      assert.equal(linkStripped, link)
    }
  )

  await run(
    'role markers: a multi-speaker reply is split in order and the plain text has no markers',
    async (page) => {
      const text =
        '⟦新角色：旁白⟧窗外竹影摇曳。\n\n' +
        '⟦新角色：贾宝玉｜音色：苏打｜性格：温润｜重要性：主角⟧「妹妹，你别恼我。」\n\n' +
        '他说着便笑了。\n\n' +
        '⟦旁白｜语气：轻叹⟧风过无声。'
      const r = await parse(page, text)
      assert.equal(r.segments.length, 3)
      assert.equal(r.segments[0].text, '窗外竹影摇曳。')
      assert.equal(r.segments[1].text, '「妹妹，你别恼我。」', 'narration after a blank line is not voiced as the speaker')
      assert.equal(r.segments[2].text, '风过无声。')
      assert.equal(r.segments[2].tone, '轻叹')
      assert.equal(r.segments[0].roleId, r.segments[2].roleId, 'narrator is one role')
      assert.equal(r.plain.includes('⟦'), false)
      assert.equal(r.plain.includes('⟧'), false)
      assert.equal(r.plain, '窗外竹影摇曳。\n\n「妹妹，你别恼我。」\n\n他说着便笑了。\n\n风过无声。')
      assert.equal(r.newRoles.length, 2)
    }
  )

  await run(
    'role markers: text between speakers that follows no marker stays in the plain text and is not voiced',
    async (page) => {
      // 标记后第一个段落（到空行）是该角色的台词；空行之后的叙述没有归属，渲染保留但不朗读
      const r = await parse(page, '⟦新角色：贾宝玉｜音色：苏打｜重要性：主角⟧你好。\n\n**无主的一段**')
      assert.equal(r.segments.length, 1)
      assert.equal(r.segments[0].text, '你好。')
      assert.equal(r.plain, '你好。\n\n**无主的一段**')
      // 只有一个段落时整段都是台词
      const single = await parse(page, '⟦新角色：贾宝玉｜音色：苏打⟧第一行\n第二行还在同一段')
      assert.equal(single.segments[0].text, '第一行\n第二行还在同一段')
    }
  )

  await run(
    'role markers: an unclosed marker at the end is hidden while streaming and ignored once complete',
    async (page) => {
      const strip = (text, streaming) =>
        page.evaluate(
          ({ text, streaming }) => window.__audit.roleMarkers.stripRoleMarkers(text, streaming),
          { text, streaming }
        )
      const partial = '他说：⟦新角色：林黛'
      assert.equal(await strip(partial, true), '他说：')
      // 没写完的标注永远不是正文，流式结束后也不该冒出来
      assert.equal(await strip(partial, false), '他说：')
      assert.equal(await strip('⟦旁白｜语气：平静⟧正文。', true), '正文。')
      assert.equal(await strip('没有标记的正文。', true), '没有标记的正文。')
    }
  )

  await run(
    'role markers: empty or nameless tags are stripped and never create a role',
    async (page) => {
      // 空括号、只有键没有值：都是模型留下的残渣，剥掉但不当角色
      const r = await parse(page, '⟦⟧空标记。⟦角色：⟧无名字。正文。')
      assert.equal(r.newRoles.length, 0, 'no name means no role')
      assert.equal(r.segments.length, 0)
      assert.equal(r.plain.includes('⟦'), false)
      assert.equal(r.plain.includes('⟧'), false)
      assert.equal(r.plain, '空标记。无名字。正文。')
    }
  )

  await run(
    'role markers: the narrator is a supporting role by default and extras share one voice when configured',
    async (page) => {
      const r = await parse(page, '⟦新角色：店小二⟧客官。⟦新角色：路人甲｜重要性：路人⟧让让。', [], { extraVoice: 'Milo' })
      const [a, b] = r.newRoles
      assert.equal(a.importance, 'extra', 'no importance declared and not the narrator means extra')
      assert.equal(a.preset, 'Milo')
      assert.equal(b.preset, 'Milo')
    }
  )

  // ---------- 角色表（roleTable）----------
  const table = (page, fn, arg) =>
    page.evaluate(new Function('arg', `const t = window.__audit.roleTable; return (${fn})(t, arg)`), arg)

  await run(
    'role table: applying a parsed reply adds roles, merges aliases and never touches locked voices',
    async (page) => {
      const r = await table(
        page,
        (t, arg) => {
          const existing = [
            { id: 'r1', name: '林黛玉', aliases: ['林妹妹'], preset: '茉莉', nature: '', importance: 'lead', source: 'user', createdAt: 1 },
          ]
          const parsed = t.applyParsedRoles(
            existing,
            {
              segments: [],
              plain: '',
              newRoles: [{ id: 'r2', name: '贾宝玉', aliases: ['宝二爷'], preset: '苏打', nature: '温润', importance: 'lead', source: 'model', createdAt: 5 }],
              aliasAdditions: [{ roleId: 'r1', aliases: ['颦儿', '颦儿'] }],
              promotions: [{ roleId: 'r1', to: 'lead' }],
              unknownNames: [], updates: [],
            }
          )
          return {
            count: parsed.length,
            lockedVoice: parsed[0].preset,
            lockedSource: parsed[0].source,
            aliases: parsed[0].aliases,
            inputUntouched: existing[0].aliases.length === 1,
            added: parsed[1].name,
          }
        },
        null
      )
      assert.equal(r.count, 2)
      assert.equal(r.lockedVoice, '茉莉')
      assert.equal(r.lockedSource, 'user')
      assert.deepEqual(r.aliases, ['林妹妹', '颦儿'], 'deduplicated')
      assert.equal(r.inputUntouched, true)
      assert.equal(r.added, '贾宝玉')
    }
  )

  await run(
    'role table: an extra promoted to supporting gets its own preset voice so it stops sharing',
    async (page) => {
      const r = await table(
        page,
        (t) => {
          const extra = { id: 'r3', name: '袭人', aliases: [], preset: '白桦', nature: '', importance: 'extra', source: 'model', createdAt: 1 }
          const promoted = t.applyParsedRoles([extra], { segments: [], plain: '', newRoles: [], aliasAdditions: [], promotions: [{ roleId: 'r3', to: 'supporting' }], unknownNames: [] })
          const before = t.effectiveVoice(extra, { extrasShareVoice: true, extraVoice: 'Milo' })
          const after = t.effectiveVoice(promoted[0], { extrasShareVoice: true, extraVoice: 'Milo' })
          // 一直没有自己音色的路人（靠解析器之外的方式建的）：升级时补一个，且不是旁白的
          const bare = { id: 'r4', name: '小红', aliases: [], nature: '', importance: 'extra', source: 'model', createdAt: 2 }
          const promotedBare = t.applyParsedRoles([bare], { segments: [], plain: '', newRoles: [], aliasAdditions: [], promotions: [{ roleId: 'r4', to: 'supporting' }], unknownNames: [] })
          return { importance: promoted[0].importance, before: before.preset, after: after.preset, unchanged: extra.importance, barePreset: promotedBare[0].preset }
        },
        null
      )
      assert.equal(r.importance, 'supporting')
      assert.equal(r.before, 'Milo', 'extras share the configured voice')
      assert.equal(r.after, '白桦', 'no longer shares once promoted: its own preset takes over')
      assert.equal(r.barePreset, '苏打', 'a walk-on that never had a voice gets one on promotion, not the narrator’s')
      assert.equal(r.unchanged, 'extra', 'input not mutated')
    }
  )

  await run(
    'role table: inheriting a conversation merges the source roles and its own inherited roles, deduplicated',
    async (page) => {
      const r = await table(
        page,
        (t) => {
          const a = { id: 'a', name: 'A', aliases: [], preset: '茉莉', nature: '', importance: 'lead', source: 'model', createdAt: 1 }
          const b = { id: 'b', name: 'B', aliases: [], preset: '苏打', nature: '', importance: 'supporting', source: 'model', createdAt: 2 }
          const c = { id: 'c', name: 'C', aliases: [], preset: '白桦', nature: '', importance: 'extra', source: 'model', createdAt: 3 }
          const own = [{ ...a, source: 'user' }]
          const merged = t.mergeInheritedRoles({ voiceRoles: own, inherited: { fromId: 'x', fromTitle: 'x', messages: [], voiceRoles: [a, b, c] } })
          return { ids: merged.map((x) => x.id), aSource: merged[0].source, ownOnly: t.mergeInheritedRoles({ voiceRoles: [a] }).length, none: t.mergeInheritedRoles({}).length }
        },
        null
      )
      assert.deepEqual(r.ids, ['a', 'b', 'c'])
      assert.equal(r.aSource, 'user', 'own copy wins over the inherited one')
      assert.equal(r.ownOnly, 1)
      assert.equal(r.none, 0)
    }
  )

  await run(
    'role table: the prompt section names leads and supporting roles, folds extras into one line, and marks user-set voices',
    async (page) => {
      const r = await table(
        page,
        (t) => {
          const roles = [
            { id: '1', name: '林黛玉', aliases: ['林妹妹', '颦儿'], preset: '茉莉', nature: '多愁善感', importance: 'lead', source: 'user', createdAt: 1 },
            { id: '2', name: '旁白', aliases: [], preset: '白桦', nature: '冷静客观', importance: 'supporting', source: 'model', createdAt: 2 },
            { id: '3', name: '王熙凤', aliases: [], description: '泼辣女声', nature: '精明', importance: 'supporting', source: 'model', createdAt: 3 },
            { id: '4', name: '店小二', aliases: ['小二'], preset: '苏打', nature: '', importance: 'extra', source: 'model', createdAt: 4 },
            { id: '5', name: '路人甲', aliases: [], preset: 'Milo', nature: '', importance: 'extra', source: 'model', createdAt: 5 },
          ]
          const text = t.formatRolesForPrompt(roles, { extrasShareVoice: true, extraVoice: 'Dean' })
          return {
            text,
            lines: text.split('\n'),
            visible: t.visibleRoleCount(roles),
            sorted: t.sortRoles([...roles].reverse()).map((x) => x.name),
            style: t.styleInstruction(roles[0], '委屈，声音发颤'),
            styleNoTone: t.styleInstruction(roles[0], ''),
            styleNothing: t.styleInstruction(undefined, ''),
          }
        },
        null
      )
      assert.equal(r.lines[0], '- 林黛玉（别名：林妹妹、颦儿）｜音色：茉莉｜性格：多愁善感｜重要性：主角｜用户设定，不可更改')
      assert.equal(r.lines[1], '- 旁白｜音色：白桦｜性格：冷静客观｜重要性：次要')
      assert.equal(r.lines[2], '- 王熙凤｜音色：泼辣女声｜性格：精明｜重要性：次要')
      assert.equal(r.lines[3], '- 其他角色 2 人｜共用音色：Dean')
      assert.equal(r.lines[4], '  （店小二/小二、路人甲）', 'extra names are listed so the model does not re-design them')
      assert.equal(r.visible, 3)
      assert.deepEqual(r.sorted, ['林黛玉', '旁白', '王熙凤', '店小二', '路人甲'])
      assert.equal(r.style, '多愁善感。委屈，声音发颤')
      assert.equal(r.styleNoTone, '多愁善感')
      assert.equal(r.styleNothing, '')
    }
  )

  await run(
    'role table: a native archive round-trips voice roles and rejects a corrupted one instead of dropping it',
    async (page) => {
      const r = await page.evaluate(() => {
        const readNativeSession = window.__audit.readNativeSession
        const session = {
          id: 'rv-session',
          title: '红楼梦',
          createdAt: 1,
          updatedAt: 2,
          messages: [],
          rootMessageId: null,
          voiceRoles: [
            { id: 'r1', name: '林黛玉', aliases: ['林妹妹'], preset: '茉莉', nature: '多愁善感', importance: 'lead', source: 'user', createdAt: 1 },
            { id: 'r2', name: '王熙凤', aliases: [], description: '泼辣女声', nature: '', importance: 'supporting', source: 'model', createdAt: 2 },
          ],
          // 接续快照里也带角色表
          inherited: { fromId: 'src', fromTitle: '源', messages: [], voiceRoles: [{ id: 'r0', name: '旁白', aliases: [], preset: '白桦', nature: '冷静客观', importance: 'supporting', source: 'model', createdAt: 0 }] },
        }
        const back = readNativeSession(JSON.parse(JSON.stringify(session)))
        // 坏数据：未知音色 ID。整表必须报错，不能静默把角色丢掉（声音会悄悄变）
        const corrupt = JSON.parse(JSON.stringify(session))
        corrupt.voiceRoles[0].preset = '不存在的音色'
        let rejected = false
        try {
          readNativeSession(corrupt)
        } catch {
          rejected = true
        }
        // 老会话没有这个字段
        const legacy = JSON.parse(JSON.stringify(session))
        delete legacy.voiceRoles
        const legacyBack = readNativeSession(legacy)
        return {
          count: back.voiceRoles?.length,
          first: back.voiceRoles?.[0],
          second: back.voiceRoles?.[1],
          inheritedRoles: back.inherited?.voiceRoles?.map((x) => x.name),
          rejected,
          legacy: legacyBack.voiceRoles === undefined,
        }
      })
      assert.equal(r.count, 2)
      assert.deepEqual(r.first, { id: 'r1', name: '林黛玉', aliases: ['林妹妹'], preset: '茉莉', nature: '多愁善感', importance: 'lead', source: 'user', createdAt: 1 })
      assert.equal(r.second.description, '泼辣女声')
      assert.equal(r.second.preset, undefined)
      assert.deepEqual(r.inheritedRoles, ['旁白'])
      assert.equal(r.rejected, true)
      assert.equal(r.legacy, true)
    }
  )

  await run(
    'role markers: the lead-voice setting decides whether a described voice is kept, extras and the narrator never get one, and 「别名：无」 is not an alias',
    async (page) => {
      const text = [
        '「新角色：林黛玉｜别名：无｜音色：年轻女声，清亮纤细｜性格：多愁善感｜重要性：主角」',
        '你别管我。',
        '',
        '「新角色：贾母｜别名：无｜音色：低沉的老年女声｜性格：慈和｜重要性：次要」',
        '快过来。',
        '',
        '「新角色：店小二｜别名：无｜音色：尖细的男声｜重要性：路人」',
        '客官里边请。',
        '',
        '「新角色：旁白｜别名：none｜音色：平板的女声｜重要性：次要」',
        '窗外竹影摇曳。',
      ].join('\n')
      const pick = (result) =>
        result.newRoles.map((role) => [role.name, role.preset ?? null, role.description ?? null, role.aliases])
      const voices = { narratorVoice: 'Mia', extraVoice: 'Milo' }
      const presetMode = await parse(page, text, [], { ...voices, allowDescription: false })
      const descriptionMode = await parse(page, text, [], { ...voices, allowDescription: true })
      // 默认不传 = 允许描述，老的调用方行为不变
      const byDefault = await parse(page, text, [], voices)

      // 后补的完整声明：预置模式下不把已有角色换成描述；路人和旁白任何时候都不换
      const existing = [
        { id: 'r1', name: '林黛玉', aliases: [], preset: '茉莉', nature: '', importance: 'lead', source: 'model', createdAt: 1 },
        { id: 'r2', name: '店小二', aliases: [], preset: 'Milo', nature: '', importance: 'extra', source: 'model', createdAt: 2 },
      ]
      const later =
        '「新角色：林黛玉｜音色：低沉沙哑的中年男声｜性格：冷｜重要性：主角」\n哼。\n\n「新角色：店小二｜音色：尖细的男声｜重要性：路人」\n客官。'
      const patches = (result) =>
        result.updates.map((item) => [item.roleId, item.patch.preset ?? null, item.patch.description ?? null, item.patch.nature ?? null])
      const updatePreset = await parse(page, later, existing, { allowDescription: false })
      const updateDescription = await parse(page, later, existing, { allowDescription: true })

      assert.deepEqual(
        pick(presetMode),
        [
          ['林黛玉', 'Mia', null, []],
          ['贾母', 'Mia', null, []],
          ['店小二', 'Milo', null, []],
          ['旁白', 'Mia', null, []],
        ],
        'preset mode: a described voice counts as no voice and falls back to the preset for that tier'
      )
      assert.deepEqual(
        pick(descriptionMode),
        [
          ['林黛玉', null, '年轻女声，清亮纤细', []],
          ['贾母', null, '低沉的老年女声', []],
          ['店小二', 'Milo', null, []],
          ['旁白', 'Mia', null, []],
        ],
        'description mode: leads and supporting roles may describe; extras and the narrator never do'
      )
      assert.deepEqual(pick(byDefault), pick(descriptionMode))
      assert.deepEqual(updatePreset.newRoles, [], 'a later declaration of a known name never creates a second role')
      assert.deepEqual(patches(updatePreset), [['r1', null, null, '冷']], 'preset mode only takes the nature from a later description')
      assert.deepEqual(patches(updateDescription), [['r1', null, '低沉沙哑的中年男声', '冷']], 'the extra is never switched to a description')
    }
  )

  // ---------- MiMo TTS 协议 ----------
  /** 模拟 MiMo /chat/completions 的 SSE：音频在 choices[0].delta.audio.data（base64 pcm16） */
  const mimoRoute = (context, handler) =>
    context.route('**/chat/completions', async (route) => {
      const request = route.request()
      const body = JSON.parse(request.postData() ?? '{}')
      const result = handler(body, request.headers())
      if (result.status) {
        return route.fulfill({ status: result.status, contentType: 'application/json', body: JSON.stringify(result.body ?? {}) })
      }
      const sse = result.chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') +
        (result.truncated ? '' : 'data: [DONE]\n\n')
      return route.fulfill({ status: 200, contentType: 'text/event-stream', body: sse })
    })
  const audioChunk = (bytes, extra = {}) => ({
    choices: [{ delta: { audio: { data: Buffer.from(bytes).toString('base64') }, ...extra } }],
    ...extra,
  })
  const profile = () => ({ id: 'xiaomimimo', revision: 'r1', name: '小米 MiMo', url: 'https://mimo.example/v1', apiKey: 'sk-test-mimo', protocol: 'openai', model: 'mimo-v2.5-tts', models: [], modelListUrl: '', headers: {}, extraBody: {} })

  await run(
    'mimo tts: a preset-voice request sends the voice, the style instruction and reads base64 pcm16 chunks in order',
    async (page) => {
      const context = page.context()
      const seen = {}
      await mimoRoute(context, (body, headers) => {
        Object.assign(seen, { body, auth: headers['authorization'] })
        return { chunks: [audioChunk([1, 2]), audioChunk([3, 4, 5]), { choices: [{ delta: {} }] }, audioChunk([6])] }
      })
      const r = await page.evaluate(async (profile) => {
        const { synthesizeMiMo } = window.__audit.speech
        const stream = await synthesizeMiMo({ profile, text: '你好。', preset: '茉莉', style: '多愁善感。委屈', signal: new AbortController().signal })
        const reader = stream.getReader()
        const out = []
      for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          out.push(...Array.from(value))
        }
        return out
      }, profile())
      assert.deepEqual(r, [1, 2, 3, 4, 5, 6], 'audio bytes come through in order, non-audio chunks skipped')
      assert.equal(seen.auth, 'Bearer sk-test-mimo')
      assert.equal(seen.body.model, 'mimo-v2.5-tts')
      assert.equal(seen.body.audio.voice, '茉莉')
      assert.equal(seen.body.audio.format, 'pcm16')
      assert.equal(seen.body.stream, true)
      assert.deepEqual(seen.body.messages, [
        { role: 'user', content: '多愁善感。委屈' },
        { role: 'assistant', content: '你好。' },
      ])
    }
  )

  await run(
    'mimo tts: a described voice switches to the voice-design model and merges description with style',
    async (page) => {
      const context = page.context()
      const seen = {}
      await mimoRoute(context, (body) => {
        Object.assign(seen, { body })
        return { chunks: [audioChunk([9])] }
      })
      const r = await page.evaluate(async (profile) => {
        const { synthesizeMiMo } = window.__audit.speech
        const stream = await synthesizeMiMo({ profile, text: '台词', description: '清冷少女音', style: '略带沙哑', signal: new AbortController().signal })
        return stream.getReader().read()
      }, profile())
      assert.deepEqual(Array.from(r.value), [9])
      assert.equal(seen.body.model, 'mimo-v2.5-tts-voicedesign')
      assert.equal(seen.body.audio.voice, undefined, 'no preset voice in design mode')
      assert.deepEqual(seen.body.messages, [
        { role: 'user', content: '清冷少女音。略带沙哑' },
        { role: 'assistant', content: '台词' },
      ])
    }
  )

  await run('mimo tts sends the dedicated service model configured in settings', async (page) => {
    const models = []
    await mimoRoute(page.context(), (body) => {
      models.push(body.model)
      return { chunks: [audioChunk([0, 1])] }
    })
    await page.evaluate(async () => {
      const a = window.__audit
      const profile = a.roleVoiceProfile.roleVoiceProfile([], {
        source: 'custom',
        providerId: null,
        custom: { url: 'https://mimo.example/v1', apiKey: 'test-speech', model: 'my-custom-speech' },
      })
      for (const voice of [{ preset: '白桦' }, { description: '清冷少女音' }]) {
        const stream = await a.speech.synthesizeMiMo({
          profile,
          ...voice,
          text: '测试。',
          style: '',
          signal: new AbortController().signal,
        })
        const reader = stream.getReader()
        while (!(await reader.read()).done) {}
      }
    })
    assert.deepEqual(models, ['my-custom-speech', 'my-custom-speech'])
  })

  await run(
    'mimo tts: an empty style omits the user message so nothing stray is spoken',
    async (page) => {
      const context = page.context()
      const seen = {}
      await mimoRoute(context, (body) => {
        Object.assign(seen, { body })
        return { chunks: [audioChunk([1])] }
      })
      await page.evaluate(async (profile) => {
        const { synthesizeMiMo } = window.__audit.speech
        const stream = await synthesizeMiMo({ profile, text: '台词', preset: '白桦', style: '   ', signal: new AbortController().signal })
        await stream.getReader().read()
      }, profile())
      assert.deepEqual(seen.body.messages, [{ role: 'assistant', content: '台词' }])
    }
  )

  await run(
    'mimo tts: an HTTP error preserves the status and gives a localized playback error',
    async (page) => {
      const context = page.context()
      await mimoRoute(context, () => ({ status: 400, body: { error: { message: 'Param Incorrect: Unknown voice' } } }))
      const r = await page.evaluate(async (profile) => {
        try {
          await window.__audit.speech.synthesizeMiMo({ profile, text: 'x', preset: '白桦', style: '', signal: new AbortController().signal })
          return { ok: true }
        } catch (error) {
          return {
            name: error.name,
            status: error.status,
            notice: window.__audit.readAloud.describeReadAloudError(error),
          }
        }
      }, profile())
      assert.equal(r.ok, undefined)
      assert.equal(r.name, 'ApiError')
      assert.equal(r.status, 400)
      assert.equal(r.notice.key, 'ttsUnavailable')
      assert.doesNotMatch(JSON.stringify(r.notice), /Unknown voice/)
    }
  )

  await run(
    'mimo tts: a stream that contains no audio is a protocol error, not silence',
    async (page) => {
      const context = page.context()
      await mimoRoute(context, () => ({ chunks: [{ choices: [{ delta: { content: 'text only' } }] }, { choices: [] }] }))
      const r = await page.evaluate(async (profile) => {
        try {
          const stream = await window.__audit.speech.synthesizeMiMo({ profile, text: 'x', preset: '白桦', style: '', signal: new AbortController().signal })
          const reader = stream.getReader()
          for (;;) {
            const { done } = await reader.read()
            if (done) {
              return { ok: true }
            }
          }
        } catch (error) {
          return { name: error.name, kind: error.kind }
        }
      }, profile())
      assert.equal(r.ok, undefined, 'must not resolve as success')
      assert.equal(r.kind, 'protocol')
    }
  )

  await run('mimo tts accepts full JSON audio and detects an incomplete audio stream', async (page) => {
    const models = []
    await mimoRoute(page.context(), (body) => {
      models.push(body.model)
      if (body.model === 'designed-voice') {
        return { status: 200, body: { choices: [{ message: { audio: { data: 'AQI=' } }, finish_reason: 'stop' }] } }
      }
      return { chunks: [audioChunk([3, 4])], truncated: true }
    })
    const result = await page.evaluate(async (profile) => {
      const a = window.__audit
      const results = []
      for (const voice of [{ description: '说话轻柔' }, { preset: '白桦' }]) {
        const bytes = []
        try {
          const stream = await a.speech.synthesizeMiMo({
            profile: { ...profile, speechModel: 'preset-voice', speechDesignModel: 'designed-voice' },
            ...voice,
            text: '测试。',
            style: '',
            signal: new AbortController().signal,
          })
          const reader = stream.getReader()
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            bytes.push(...value)
          }
          results.push({ bytes })
        } catch (error) {
          results.push({ notice: a.readAloud.describeReadAloudError(error).key })
        }
      }
      return results
    }, profile())
    assert.deepEqual(models, ['designed-voice', 'preset-voice'])
    assert.deepEqual(result, [{ bytes: [1, 2] }, { notice: 'ttsInterrupted' }])
  })

  // ---------- 多段播放队列 ----------
  /** 假的 AudioContext：记录每次排程的时间和时长，onended 手动触发 */
  const fakeAudio = (page) =>
    page.evaluate(() => {
      const log = []
      let t = 0
      class FakeSource {
        constructor() {
          this.buffer = null
          log.push({ type: 'create' })
        }
        connect() {}
        disconnect() {}
        start(when) {
          this.when = when
          log.push({ type: 'start', when, duration: this.buffer.duration })
        }
        end() {
          this.onended?.()
        }
      }
      class FakeContext {
        constructor() {
          this.state = 'running'
          this.destination = {}
          this.sources = []
        }
        get currentTime() {
          return t
        }
        resume() {
          return Promise.resolve()
        }
        createBuffer(channels, length) {
          return { duration: length / 24000, copyToChannel() {} }
        }
        createBufferSource() {
          const s = new FakeSource()
          this.sources.push(s)
          return s
        }
        close() {
          this.state = 'closed'
          return Promise.resolve()
        }
      }
      const origFetch = window.fetch
      window.__audioLog = log
      window.__audioContexts = []
      window.AudioContext = class extends FakeContext {
        constructor(opts) {
          super(opts)
          window.__audioContexts.push(this)
        }
      }
      window.fetch = async (url, init) => {
        const body = JSON.parse(init.body)
        window.__audioRequests = window.__audioRequests || []
        window.__audioRequests.push({ voice: body.audio?.voice, model: body.model, style: body.messages?.[0]?.role === 'user' ? body.messages[0].content : undefined, text: body.messages.at(-1).content })
        // 每段 1 秒静音（24000 采样 × 2 字节）；分块编码，一次展开 48000 个参数会栈溢出
        const pcm = new Uint8Array(24000 * 2)
        let binary = ''
        for (let i = 0; i < pcm.length; i += 8192) {
          binary += String.fromCharCode(...pcm.subarray(i, i + 8192))
        }
        const b64 = btoa(binary)
        const sse = `data: ${JSON.stringify({ choices: [{ delta: { audio: { data: b64 } } }] })}\n\ndata: [DONE]\n\n`
        return new Response(sse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
      }
      return { origFetch }
    })

  const roles = () => [
    { id: 'n', name: '旁白', aliases: [], preset: '白桦', nature: '冷静客观', importance: 'supporting', source: 'model', createdAt: 1 },
    { id: 'd', name: '林黛玉', aliases: [], preset: '茉莉', nature: '多愁善感', importance: 'lead', source: 'model', createdAt: 2 },
    { id: 'x', name: '店小二', aliases: [], preset: '苏打', nature: '', importance: 'extra', source: 'model', createdAt: 3 },
  ]

  await run(
    'role playback: each segment is requested with its own voice and style, scheduled in order with a gap',
    async (page) => {
      await fakeAudio(page)
      const r = await page.evaluate(async (roles) => {
        const a = window.__audit
        const errors = []
        a.readAloud.toggleRoleReadAloud(
          {
            messageId: 'm1',
            segments: [
              { roleId: 'n', tone: '', text: '窗外竹影。' },
              { roleId: 'd', tone: '委屈，声音发颤', text: '你别管我。' },
              { roleId: 'x', tone: '吆喝', text: '客官里边请！' },
            ],
            roles,
            profile: { id: 'xiaomimimo', revision: 'r1', name: '小米 MiMo', url: 'https://mimo.example/v1', apiKey: 'k', protocol: 'openai', model: 'm', models: [], modelListUrl: '', headers: {}, extraBody: {} },
            extrasShareVoice: false,
            extraVoice: 'Dean',
          },
          (e) => errors.push(e.message)
        )
        await new Promise((r) => setTimeout(r, 400))
        const ctx = window.__audioContexts[0]
        const starts = window.__audioLog.filter((x) => x.type === 'start')
        // 先读「正在读谁」——模拟播完之后状态会回到 idle
        const speaking = a.readAloud.useReadAloud.getState().speakingRole
        const playingStatus = a.readAloud.useReadAloud.getState().status
        // 模拟播完
        for (const s of ctx.sources) s.end()
        await new Promise((r) => setTimeout(r, 100))
        return {
          requests: window.__audioRequests,
          starts,
          speaking,
          playingStatus,
          status: a.readAloud.useReadAloud.getState().status,
          errors,
        }
      }, roles())
      assert.deepEqual(r.requests.map((q) => q.voice), ['白桦', '茉莉', '苏打'], 'each role uses its own preset')
      assert.deepEqual(r.requests.map((q) => q.style), ['冷静客观', '多愁善感。委屈，声音发颤', '吆喝'], 'style = nature + tone; nature alone when the tone is empty, tone alone when there is no nature')
      assert.deepEqual(r.requests.map((q) => q.text), ['窗外竹影。', '你别管我。', '客官里边请！'])
      assert.equal(r.starts.length, 3)
      assert.ok(r.starts[1].when >= r.starts[0].when + r.starts[0].duration + 0.2, 'a gap separates speakers')
      assert.ok(r.starts[2].when >= r.starts[1].when + r.starts[1].duration + 0.2)
      assert.equal(r.playingStatus, 'playing')
      assert.equal(r.speaking, '旁白', 'queued voices never replace the audible speaker')
      assert.equal(r.status, 'idle', 'returns to idle once every source ended')
      assert.deepEqual(r.errors, [])
    }
  )

  await run(
    'role playback: extras share one voice when enabled; stopping mid-way aborts the whole queue',
    async (page) => {
      await fakeAudio(page)
      const r = await page.evaluate(async (roles) => {
        const a = window.__audit
        const errors = []
        a.readAloud.toggleRoleReadAloud(
          {
            messageId: 'm2',
            segments: [
              { roleId: 'x', tone: '', text: '一' },
              { roleId: 'n', tone: '', text: '二' },
            ],
            roles,
            profile: { id: 'xiaomimimo', revision: 'r1', name: '小米 MiMo', url: 'https://mimo.example/v1', apiKey: 'k', protocol: 'openai', model: 'm', models: [], modelListUrl: '', headers: {}, extraBody: {} },
            extrasShareVoice: true,
            extraVoice: 'Dean',
          },
          (e) => errors.push(e.message)
        )
        await new Promise((r) => setTimeout(r, 250))
        const sharedVoice = window.__audioRequests[0].voice
        a.readAloud.stopReadAloud()
        await new Promise((r) => setTimeout(r, 150))
        const requestsBefore = window.__audioRequests.length
        // 停止后再等，不应再有新请求
        await new Promise((r) => setTimeout(r, 200))
        return { sharedVoice, status: a.readAloud.useReadAloud.getState().status, noMore: window.__audioRequests.length === requestsBefore, errors }
      }, roles())
      assert.equal(r.sharedVoice, 'Dean', 'extras use the shared voice')
      assert.equal(r.status, 'idle')
      assert.equal(r.noMore, true)
      assert.deepEqual(r.errors, [], 'a user stop is not an error')
    }
  )

  await run(
    'role playback: a failing segment stops the whole reply and reports the error once',
    async (page) => {
      await fakeAudio(page)
      const r = await page.evaluate(async (roles) => {
        const a = window.__audit
        const errors = []
        let calls = 0
        const realFetch = window.fetch
        window.fetch = async (url, init) => {
          calls += 1
          if (calls === 2) {
            return new Response(JSON.stringify({ error: { message: 'quota' } }), { status: 429, headers: { 'Content-Type': 'application/json' } })
          }
          return realFetch(url, init)
        }
        a.readAloud.toggleRoleReadAloud(
          {
            messageId: 'm3',
            segments: [
              { roleId: 'n', tone: '', text: '一' },
              { roleId: 'd', tone: '', text: '二' },
              { roleId: 'x', tone: '', text: '三' },
            ],
            roles,
            profile: { id: 'xiaomimimo', revision: 'r1', name: '小米 MiMo', url: 'https://mimo.example/v1', apiKey: 'k', protocol: 'openai', model: 'm', models: [], modelListUrl: '', headers: {}, extraBody: {} },
            extrasShareVoice: false,
            extraVoice: 'Dean',
          },
          (e) => errors.push(e.status ?? e.message)
        )
        await new Promise((r) => setTimeout(r, 600))
        return { calls, status: a.readAloud.useReadAloud.getState().status, errors }
      }, roles())
      assert.equal(r.calls, 2, 'the third segment is never requested after the second fails')
      assert.equal(r.status, 'idle')
      assert.deepEqual(r.errors, [429])
    }
  )

  // ---------- 接到聊天链路：端到端 ----------
  /** 拦截发给模型的请求，按顺序返回预设回复 */
  const chatRoute = (page, replies) =>
    page.evaluate((replies) => {
      const a = window.__audit
      const ordinary = window.fetch
      window.__rvRequests = []
      window.__rvReplies = [...replies]
      window.fetch = async (url, init) => {
        if (!String(url).endsWith('/messages')) {
          return ordinary(url, init)
        }
        window.__rvRequests.push(JSON.parse(init.body))
        const next = window.__rvReplies.shift() ?? '（没有更多回复）'
        return a.response(next)
      }
    }, replies)
  const DAIYU_DECL = '⟦新角色：林黛玉｜别名：林妹妹、颦儿｜音色：茉莉｜性格：多愁善感，说话轻柔｜重要性：主角⟧你别管我。'
  const NARRATOR_DECL = '⟦新角色：旁白⟧窗外竹影摇曳。'

  await run(
    'role voice end-to-end: enabled adds the tagging rules, roles from the reply land on the session, and the next turn carries the table',
    async (page) => {
      await chatRoute(page, [`${NARRATOR_DECL}\n\n${DAIYU_DECL}`, '⟦林妹妹｜语气：委屈，声音发颤⟧你也不用说誓。'])
      const r = await page.evaluate(async () => {
        const a = window.__audit
        const out = {}
        a.settings.setApiKey('fixture')
        a.settings.setRoleVoice({ enabled: true })
        await a.seed([a.fixtures.session({ id: 'rv-e2e', messages: [] })])
        a.drafts.setDraftText('rv-e2e', '写一段黛玉和宝玉的对话')
        a.store.sendMessage('rv-e2e')
        await a.waitIdle()
        let session = a.store.useChatStore.getState().sessionCache['rv-e2e']
        out.turn1 = {
          systemHasRules: String(window.__rvRequests[0].system).includes('【朗读标注】'),
          systemHasTable: String(window.__rvRequests[0].system).includes('【已定角色】'),
          roles: (session.voiceRoles ?? []).map((role) => [role.name, role.preset, role.importance, role.aliases]),
          // 前台渲染不该看到标记——消息正文里保留，渲染时剥掉（下一步实现）
          replyHasMarkers: a.roleMarkers.hasRoleMarkers(session.messages.at(-1).blocks.map((b) => b.text ?? '').join('')),
        }
        a.drafts.setDraftText('rv-e2e', '继续')
        a.store.sendMessage('rv-e2e')
        await a.waitIdle()
        session = a.store.useChatStore.getState().sessionCache['rv-e2e']
        const system2 = String(window.__rvRequests[1].system)
        out.turn2 = {
          tableListsDaiyu: system2.includes('林黛玉（别名：林妹妹、颦儿）｜音色：茉莉'),
          tableMarksLead: system2.includes('重要性：主角'),
          tableListsNarrator: system2.includes('旁白｜音色：白桦'),
          stillTwoRoles: (session.voiceRoles ?? []).length === 2,
          // 第二轮的「林妹妹」解析成了已存在的黛玉，不该新建
          plainTurn2: a.roleMarkers.parseRoleMarkers(
            session.messages.at(-1).blocks.map((b) => b.text ?? '').join(''),
            session.voiceRoles ?? []
          ).segments.map((s) => s.tone),
        }
        return out
      })
      assert.equal(r.turn1.systemHasRules, true)
      assert.equal(r.turn1.systemHasTable, false, 'no table yet on the first turn')
      assert.deepEqual(r.turn1.roles, [
        ['旁白', '白桦', 'supporting', []],
        ['林黛玉', '茉莉', 'lead', ['林妹妹', '颦儿']],
      ])
      assert.equal(r.turn2.tableListsDaiyu, true, 'the established table is sent back on the next turn')
      assert.equal(r.turn2.tableMarksLead, true)
      assert.equal(r.turn2.tableListsNarrator, true)
      assert.equal(r.turn2.stillTwoRoles, true, 'an alias must resolve to the existing role, not create a new one')
      assert.deepEqual(r.turn2.plainTurn2, ['委屈，声音发颤'])
    }
  )

  await run(
    'role voice end-to-end: disabled adds nothing, and a stopped reply does not create roles',
    async (page) => {
      await chatRoute(page, [DAIYU_DECL])
      const r = await page.evaluate(async () => {
        const a = window.__audit
        const out = {}
        a.settings.setApiKey('fixture')
        a.settings.setRoleVoice({ enabled: false })
        await a.seed([a.fixtures.session({ id: 'rv-off', messages: [] })])
        a.drafts.setDraftText('rv-off', '写')
        a.store.sendMessage('rv-off')
        await a.waitIdle()
        let session = a.store.useChatStore.getState().sessionCache['rv-off']
        out.off = {
          systemHasRules: String(window.__rvRequests[0].system).includes('朗读标注'),
          roles: session.voiceRoles ?? null,
        }
        return out
      })
      assert.equal(r.off.systemHasRules, false)
      assert.equal(r.off.roles, null, 'roles are not collected while the feature is off')

      const stopped = await page.evaluate(async () => {
        const a = window.__audit
        a.settings.setRoleVoice({ enabled: true })
        // 直接验证写回函数：状态不是 done 的回答不产生角色
        const session = a.fixtures.session({ id: 'rv-stopped', messages: [] })
        const reply = a.fixtures.assistant('r1', '⟦新角色：晴雯｜音色：茉莉｜重要性：主角⟧我不过是个丫头。', {
          status: 'stopped',
          prefix: false,
        })
        const afterStopped = a.roleVoiceBridge.withReplyRoles(session, reply, a.settings.useSettings.getState().roleVoice)
        const done = a.fixtures.assistant('r2', '⟦新角色：晴雯｜音色：茉莉｜重要性：主角⟧我不过是个丫头。')
        const afterDone = a.roleVoiceBridge.withReplyRoles(session, done, a.settings.useSettings.getState().roleVoice)
        const template = a.fixtures.assistant('r3', '', { blocks: [{ type: 'text', text: '⟦新角色：模板人｜音色：茉莉⟧x', isTemplate: true }] })
        const afterTemplate = a.roleVoiceBridge.withReplyRoles(session, template, a.settings.useSettings.getState().roleVoice)
        return {
          stopped: afterStopped.voiceRoles ?? null,
          done: afterDone.voiceRoles?.map((x) => x.name),
          sameRef: afterStopped === session,
          template: afterTemplate.voiceRoles ?? null,
        }
      })
      assert.equal(stopped.stopped, null)
      assert.equal(stopped.done?.[0], '晴雯')
      assert.equal(stopped.template, null, 'server template text is never parsed')
    }
  )

  await run(
    'role voice end-to-end: the lead-voice setting reaches the prompt and the stored role, and a reply that only refines a role is written back',
    async (page) => {
      const describedLead = '「新角色：林黛玉｜别名：无｜音色：年轻女声，清亮纤细｜性格：多愁善感｜重要性：主角」\n你别管我。'
      await chatRoute(page, [describedLead, describedLead, describedLead])
      const r = await page.evaluate(async (describedLead) => {
        const a = window.__audit
        const out = {}
        a.settings.setApiKey('fixture')

        // 只后补了音色和性格（重要性没升、没加别名）的回答也要写回会话
        a.settings.setRoleVoice({ enabled: true, leadVoice: 'preset' })
        const refine = '「新角色：王熙凤｜别名：无｜音色：Chloe｜性格：泼辣｜重要性：路人」\n我来迟了。'
        const base = a.fixtures.session({
          id: 'rv-refine',
          messages: [],
          voiceRoles: [{ id: 'r1', name: '王熙凤', aliases: [], preset: '苏打', nature: '', importance: 'extra', source: 'model', createdAt: 1 }],
        })
        const refined = a.roleVoiceBridge.withReplyRoles(
          base,
          a.fixtures.assistant('x1', refine),
          a.settings.useSettings.getState().roleVoice
        )
        out.refined = refined === base ? null : [refined.voiceRoles[0].preset, refined.voiceRoles[0].nature]

        await a.seed([
          a.fixtures.session({ id: 'rv-lead-preset', messages: [] }),
          a.fixtures.session({ id: 'rv-lead-desc', messages: [] }),
          a.fixtures.session({ id: 'rv-lead-en', messages: [] }),
        ])
        const voice = (role) => (role ? [role.preset ?? null, role.description ?? null, role.importance, role.aliases] : null)
        const send = async (id, leadVoice) => {
          a.settings.setRoleVoice({ enabled: true, leadVoice })
          const before = window.__rvRequests.length
          a.drafts.setDraftText(id, '写')
          a.store.sendMessage(id)
          await a.waitIdle()
          const system = String(window.__rvRequests[before].system)
          return {
            presetOnly: system.includes('不要写音色描述') || system.includes('never a description'),
            describedExample: system.includes('年轻女声，清亮纤细，说话轻缓'),
            leadMustDescribe: system.includes('主角要用一句话描述音色') || system.includes('A lead uses a one-line voice description'),
            // 音色按语言分组列，且只列编辑弹窗里选得到的 8 个
            languageLabels: system.includes('中文女声：冰糖、茉莉') || system.includes('Chinese female: 冰糖'),
            offersUnknownVoice: system.includes('mimo_default'),
            role: voice(a.store.useChatStore.getState().sessionCache[id].voiceRoles?.[0]),
          }
        }
        out.preset = await send('rv-lead-preset', 'preset')
        out.description = await send('rv-lead-desc', 'description')
        // 切换设置之后，之前建好的角色原样不动
        out.untouched = voice(a.store.useChatStore.getState().sessionCache['rv-lead-preset'].voiceRoles?.[0])

        a.settings.setLocale('en-US')
        out.english = await send('rv-lead-en', 'description')
        a.settings.setLocale('zh-CN')
        a.settings.setRoleVoice({ enabled: false })
        return out
      }, describedLead)
      assert.deepEqual(r.refined, ['Chloe', '泼辣'], 'a reply that only refines a role is not dropped')
      assert.deepEqual(r.preset.role, ['白桦', null, 'lead', []], 'preset mode: the description the model wrote anyway falls back to a preset')
      assert.equal(r.preset.presetOnly, true)
      assert.equal(r.preset.describedExample, false)
      assert.equal(r.preset.leadMustDescribe, false)
      assert.deepEqual(r.description.role, [null, '年轻女声，清亮纤细', 'lead', []], 'description mode keeps what the model wrote')
      assert.equal(r.description.presetOnly, false)
      assert.equal(r.description.describedExample, true, 'the worked example follows the setting')
      assert.equal(r.description.leadMustDescribe, true)
      assert.deepEqual(r.untouched, ['白桦', null, 'lead', []], 'switching the setting later leaves roles that already exist alone')
      // 实测模型会把中文角色分到英文音色（让 Dean 念中文台词），所以清单必须按语言分组；
      // mimo_default 不在应用的音色目录里，模型选了它，编辑弹窗里显示不出
      for (const mode of ['preset', 'description', 'english']) {
        assert.equal(r[mode].languageLabels, true, `${mode}: presets are listed by language`)
        assert.equal(r[mode].offersUnknownVoice, false, `${mode}: a voice the dialog cannot show is never offered`)
      }
      assert.equal(r.english.presetOnly, false)
      assert.equal(r.english.leadMustDescribe, true, 'the English rules follow the setting too')
      assert.equal(r.english.describedExample, true)
      assert.deepEqual(r.english.role, [null, '年轻女声，清亮纤细', 'lead', []])
    }
  )

  // ---------- 前台渲染：看不到任何标注 ----------
  await run(
    'role voice view: markers never reach the rendered markdown, and a half-typed marker is hidden while streaming',
    async (page) => {
      const r = await page.evaluate(() => {
        const a = window.__audit
        const build = (text, streaming) =>
          a.chatView.buildReplyView(
            a.fixtures.assistant('v1', text, { status: streaming ? 'streaming' : 'done' }),
            streaming
          )
        const done = build('⟦新角色：林黛玉｜音色：茉莉｜重要性：主角⟧你别管我。\n\n⟦旁白⟧风过无声。', false)
        const streaming = build('他说：⟦新角色：林黛', true)
        const citations = build('⟦旁白｜语气：平静⟧正文。[citation:1]'.replace('[citation:1]', ''), false)
        return {
          doneText: done.answer?.text,
          doneMarkdown: done.answer?.markdown,
          streamingText: streaming.answer?.text ?? streaming.steps.map((s) => s.markdown ?? '').join(''),
          plain: citations.answer?.text,
        }
      })
      assert.equal(r.doneText, '你别管我。\n\n风过无声。', 'markers stripped from the visible text')
      assert.equal(r.doneMarkdown, '你别管我。\n\n风过无声。')
      assert.equal(r.doneText.includes('⟦'), false)
      assert.equal(r.streamingText, '他说：', 'the unclosed marker is hidden while streaming')
      assert.equal(r.plain, '正文。')
    }
  )

  // ---------- 设置页 ----------
  await run(
    'role voice settings: the switch reveals the voice controls, persists, and warns when MiMo is missing',
    async (page) => {
      const r = await page.evaluate(async () => {
        const a = window.__audit
        a.settings.setRoleVoice({ enabled: false })
        return { before: a.settings.useSettings.getState().roleVoice }
      })
      assert.equal(r.before.enabled, false)

      // 直接打开聊天偏好页，避免依赖目录导航
      await page.evaluate(() => window.__audit.settingsDialog.openSettings('chat'))
      await page.waitForTimeout(300)
      const switchName = await page.evaluate(() => {
        const rows = [...document.querySelectorAll('[role="switch"], input[type="checkbox"]')]
        return rows.length
      })
      // 用 store 驱动，再验证界面确实反映状态
      await page.evaluate(() => window.__audit.settings.setRoleVoice({ enabled: true }))
      await page.waitForTimeout(250)
      const shown = await page.evaluate(() => {
        const text = document.body.innerText
        return {
          hasHint: text.includes('不同角色会用不同声音'),
          hasLead: text.includes('主角默认音色'),
          hasNarrator: text.includes('旁白音色'),
          hasExtra: text.includes('路人共用音色'),
          hasShare: text.includes('路人角色共用声音'),
          // 没有 MiMo 配置时应提示去配置
          needsSetup: text.includes('还没有配置 MiMo') || text.includes('已复用你配置的 MiMo'),
        }
      })
      assert.ok(switchName >= 1, 'a switch is rendered')
      assert.equal(shown.hasHint, true)
      assert.equal(shown.hasLead, true)
      assert.equal(shown.hasNarrator, true)
      assert.equal(shown.hasExtra, true)
      assert.equal(shown.hasShare, true)
      assert.equal(shown.needsSetup, true, 'the read-aloud model line is always shown')

      // 关掉后详细项应收起
      await page.evaluate(() => window.__audit.settings.setRoleVoice({ enabled: false }))
      await page.waitForTimeout(250)
      const collapsed = await page.evaluate(() => document.body.innerText.includes('主角默认音色'))
      assert.equal(collapsed, false, 'controls collapse when the feature is off')

      // 持久化：写 localStorage 再读回
      const stored = await page.evaluate(() => {
        window.__audit.settings.setRoleVoice({ narratorVoice: '茉莉', extrasShareVoice: false })
        return JSON.parse(localStorage.getItem('freeseek:role-voice'))
      })
      assert.equal(stored.narratorVoice, '茉莉')
      assert.equal(stored.extrasShareVoice, false)
      assert.equal(stored.extraVoice, '苏打', 'walk-ons default to a voice of their own, not the narrator’s')
    }
  )

  // ---------- 顶栏按钮与面板 ----------
  const seedRoles = async (page, roles, options = {}) =>
    page.evaluate(
      async ({ roles, options }) => {
        const a = window.__audit
        a.settings.setRoleVoice({ enabled: true, providerId: null, ...options })
        // 面板要能看到角色列表，需要有一个可用的 MiMo 配置
        a.providers.saveProvider(
          {
            ...a.providers.emptyProfile(),
            name: '小米 MiMo',
            protocol: 'openai',
            url: 'https://api.xiaomimimo.com/v1',
            apiKey: 'sk-test-mimo',
            model: 'mimo-v2.5-tts',
            models: ['mimo-v2.5-tts'],
          },
          true
        )
        await a.seed([
          a.fixtures.session({ id: 'rv-ui', title: '红楼梦', messages: [], voiceRoles: roles }),
        ])
        a.store.selectSession('rv-ui')
      },
      { roles, options }
    )
  const named = (id, name, extra = {}) => ({
    id,
    name,
    aliases: [],
    preset: '茉莉',
    nature: '多愁善感',
    importance: 'lead',
    source: 'model',
    createdAt: 1,
    ...extra,
  })

  await run(
    'role voice ui: the header button shows the named-role count and opens a panel with every role',
    async (page) => {
      await seedRoles(page, [
        named('r1', '林黛玉', { importance: 'lead', aliases: ['林妹妹', '颦儿'] }),
        named('r2', '旁白', { importance: 'supporting', preset: '白桦' }),
        named('r3', '王熙凤', { importance: 'supporting', preset: '冰糖' }),
        named('r4', '店小二', { importance: 'extra', preset: '苏打' }),
        named('r5', '路人甲', { importance: 'extra', preset: 'Milo' }),
      ])
      const trigger = page.locator('[data-role-voice-trigger]')
      await trigger.waitFor({ timeout: 15000 })
      assert.match((await trigger.getAttribute('aria-label')) ?? '', /3 个角色/, 'extras are not counted in the badge')
      await trigger.click()
      const list = page.getByTestId('role-voice-list')
      await list.waitFor()
      const text = await list.innerText()
      assert.match(text, /林黛玉/)
      assert.match(text, /林妹妹 · 颦儿/)
      assert.match(text, /旁白/)
      assert.match(text, /王熙凤/)
      assert.match(text, /其他角色 2 人/, 'extras fold into one row')
      assert.equal(text.includes('店小二'), false, 'extras hidden until expanded')
      await page.getByRole('button', { name: /其他角色 2 人/ }).click()
      await page.waitForTimeout(200)
      const expanded = await list.innerText()
      assert.match(expanded, /店小二/)
      assert.match(expanded, /路人甲/)
      if (process.env.FREESEEK_SPEECH_PREVIEWS) {
        await page.screenshot({ path: 'tmp/regression/role-voice-list-zh.png', animations: 'disabled' })
      }
    }
  )

  await run('role voice panel accepts pointer input on a dark desktop', async (page) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    await seedRoles(page, [named('r1', '林黛玉', { aliases: ['林妹妹'] })])
    await page.evaluate(() => window.__audit.settings.setThemePreference('dark'))
    await page.locator('[data-role-voice-trigger]').click()
    const list = page.getByTestId('role-voice-list')
    await list.waitFor()
    assert.match(await list.innerText(), /林黛玉/)
    if (process.env.FREESEEK_SPEECH_PREVIEWS) {
      await page.screenshot({ path: 'tmp/regression/role-voice-list-desktop-zh.png', animations: 'disabled' })
    }
  })

  await run(
    'role voice ui: the button stays hidden while the feature is off or the session has no roles',
    async (page) => {
      await page.evaluate(async () => {
        const a = window.__audit
        a.settings.setRoleVoice({ enabled: false })
        const role = { id: 'x', name: '某人', aliases: [], preset: '茉莉', nature: '', importance: 'lead', source: 'model', createdAt: 1 }
        await a.seed([
          a.fixtures.session({ id: 'rv-ui-off', title: '空', messages: [], voiceRoles: [role] }),
        ])
        a.store.selectSession('rv-ui-off')
      })
      await page.waitForFunction(
        () => window.__audit.store.useChatStore.getState().activeId === 'rv-ui-off'
      )
      await page.waitForTimeout(600)
      assert.equal(await page.locator('[data-role-voice-trigger]').count(), 0, 'off hides the button')

      await page.evaluate(async () => {
        const a = window.__audit
        a.settings.setRoleVoice({ enabled: true })
        await a.seed([a.fixtures.session({ id: 'rv-ui-empty', title: '没有角色', messages: [] })])
        a.store.selectSession('rv-ui-empty')
      })
      await page.waitForFunction(
        () => window.__audit.store.useChatStore.getState().activeId === 'rv-ui-empty'
      )
      await page.waitForTimeout(600)
      assert.equal(await page.locator('[data-role-voice-trigger]').count(), 0, 'no roles hides the button')
    }
  )

  await run(
    'role voice ui: editing a role saves the new voice back onto the session',
    async (page) => {
      await seedRoles(page, [named('r1', '林黛玉', { aliases: ['林妹妹'], importance: 'lead' })])
      const trigger = page.locator('[data-role-voice-trigger]')
      await trigger.waitFor({ timeout: 15000 })
      await trigger.click()
      await page.getByTestId('role-voice-list').waitFor()
      await page.getByRole('button', { name: '编辑 林黛玉 的声音' }).click()
      const dialog = page.getByRole('dialog', { name: '编辑角色' })
      await dialog.waitFor()
      if (process.env.FREESEEK_SPEECH_PREVIEWS) {
        await page.screenshot({ path: 'tmp/regression/role-voice-editor-zh.png', animations: 'disabled' })
      }
      // 改成白桦并加一个别名
      await dialog.getByRole('radio', { name: /白桦/ }).check()
      const alias = dialog.getByLabel('添加别名')
      await alias.fill('颦儿')
      await alias.press('Enter')
      await dialog.getByLabel('性格底色').fill('多愁善感，说话轻柔')
      await dialog.getByRole('button', { name: '保存并试听' }).click()
      await page.waitForTimeout(500)
      const saved = await page.evaluate(
        () => window.__audit.store.useChatStore.getState().sessionCache['rv-ui'].voiceRoles?.[0]
      )
      assert.equal(saved?.preset, '白桦')
      assert.deepEqual(saved?.aliases, ['林妹妹', '颦儿'])
      assert.equal(saved?.nature, '多愁善感，说话轻柔')
      assert.equal(saved?.source, 'user', 'a user edit locks the voice against the model')
    }
  )

  await run('role voice keeps an extras-only conversation editable on a narrow screen without MiMo', async (page) => {
    await page.setViewportSize({ width: 320, height: 640 })
    await seedRoles(page, [named('r1', '路人甲', { importance: 'extra', preset: 'Milo' })])
    await page.evaluate(() => window.__audit.settings.setRoleVoice({
      source: 'custom', custom: { url: '', apiKey: '', model: '' },
    }))
    const trigger = page.locator('[data-role-voice-trigger]')
    await trigger.click()
    await page.getByRole('button', { name: /其他角色 1 人/ }).click()
    const list = page.getByTestId('role-voice-list')
    assert.equal(await list.getByRole('button', { name: '试听 路人甲' }).count(), 0)
    await list.getByRole('button', { name: '编辑 路人甲 的声音' }).click()
    const editor = page.getByRole('dialog', { name: '编辑角色' })
    const bounds = await editor.boundingBox()
    assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 320)
    await editor.getByLabel('名字').fill('过路人')
    await editor.getByRole('button', { name: '保存', exact: true }).click()
    await editor.waitFor({ state: 'hidden' })
    const saved = await page.evaluate(() => window.__audit.store.useChatStore.getState().sessionCache['rv-ui'].voiceRoles[0])
    assert.equal(saved.name, '过路人')
    assert.deepEqual(saved.aliases, ['路人甲'], 'old dialogue keeps matching this role')
    assert.equal(saved.preset, 'Milo', 'editing while sharing a voice keeps the role’s own sound')
  })

  // ---------- 回答朗读按钮 ----------
  /** 装好角色配音环境：MiMo 配置 + 角色表 + 一条带标注的回答 */
  const seedReply = async (page, replyText, roles) =>
    page.evaluate(
      async ({ replyText, roles }) => {
        const a = window.__audit
        a.settings.setRoleVoice({ enabled: true, providerId: null })
        a.providers.saveProvider(
          {
            ...a.providers.emptyProfile(),
            name: '小米 MiMo',
            protocol: 'openai',
            url: 'https://api.xiaomimimo.com/v1',
            apiKey: 'sk-test-mimo',
            model: 'mimo-v2.5-tts',
            models: ['mimo-v2.5-tts'],
          },
          true
        )
        await a.seed([
          a.fixtures.session({
            id: 'rv-read',
            title: '红楼梦',
            voiceRoles: roles,
            messages: [
              a.fixtures.user('u1', '写一段'),
              a.fixtures.assistant('a1', replyText),
            ],
          }),
        ])
        a.store.selectSession('rv-read')
        // 拦截 MiMo，记录每段请求；假 AudioContext 让播放走完
        window.__ttsRequests = []
        const ordinary = window.fetch
        window.fetch = async (url, init) => {
          if (!String(url).includes('xiaomimimo')) {
            return ordinary(url, init)
          }
          const body = JSON.parse(init.body)
          window.__ttsRequests.push({ voice: body.audio?.voice, text: body.messages.at(-1).content })
          const pcm = new Uint8Array(2400 * 2)
          let binary = ''
          for (let i = 0; i < pcm.length; i += 8192) binary += String.fromCharCode(...pcm.subarray(i, i + 8192))
          const sse = `data: ${JSON.stringify({ choices: [{ delta: { audio: { data: btoa(binary) } } }] })}\n\ndata: [DONE]\n\n`
          return new Response(sse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
        }
      },
      { replyText, roles }
    )

  await run(
    'role voice read-aloud: a tagged reply is read in one request per character, each with its own voice',
    async (page) => {
      await seedReply(
        page,
        '⟦旁白⟧窗外竹影。\n\n⟦林黛玉｜语气：委屈⟧你别管我。\n\n⟦旁白｜语气：轻叹⟧风过无声。',
        [named('n', '旁白', { preset: '白桦', importance: 'supporting' }), named('d', '林黛玉', { preset: '茉莉' })]
      )
      await page.waitForTimeout(600)
      const button = page.getByRole('button', { name: '朗读' }).first()
      await button.waitFor({ timeout: 15000 })
      await button.click()
      await page.waitForFunction(() => (window.__ttsRequests ?? []).length >= 3, null, { timeout: 10000 })
      await page.waitForTimeout(300)
      const requests = await page.evaluate(() => window.__ttsRequests)
      assert.equal(requests.length, 3, 'one TTS request per segment')
      assert.deepEqual(requests.map((r) => r.voice), ['白桦', '茉莉', '白桦'])
      assert.deepEqual(
        requests.map((r) => r.text),
        ['窗外竹影。', '你别管我。', '风过无声。']
      )
    }
  )

  await run('role voice reads untagged narration before, between and after dialogue', async (page) => {
    await seedReply(page, [
      '开场。', '', '⟦林黛玉⟧你来了。', '', '竹影微动。', '', '⟦店小二⟧请进。', '', '天色转暗。',
    ].join('\n'), [named('d', '林黛玉'), named('x', '店小二', { importance: 'extra', preset: 'Dean' })])
    await page.getByRole('button', { name: '朗读' }).first().click()
    await page.waitForFunction(() => window.__ttsRequests.length === 5)
    const requests = await page.evaluate(() => window.__ttsRequests)
    assert.deepEqual(requests.map(({ voice, text }) => [voice, text]), [
      ['白桦', '开场。'], ['茉莉', '你来了。'], ['白桦', '竹影微动。'],
      ['苏打', '请进。'], ['白桦', '天色转暗。'],
    ])
  })

  await run(
    'role voice read-aloud: an untagged reply still uses the plain single-request path',
    async (page) => {
      await seedReply(page, '今天天气不错，适合出去走走。', [named('d', '林黛玉')])
      const deepseek = []
      await page.route('**/v1/tools/tts', async (route) => {
        deepseek.push(route.request().postDataJSON())
        await route.fulfill({ contentType: 'audio/pcm', body: Buffer.alloc(2400 * 2) })
      })
      await page.evaluate(() => {
        window.__audit.settings.setApiKey('fixture-official')
        window.__audit.providers.selectModel({ providerId: 'deepseek', model: 'deepseek-flash' })
      })
      const synthesis = page.waitForResponse('**/v1/tools/tts')
      await page.getByRole('button', { name: '朗读' }).first().click()
      await synthesis
      const requests = await page.evaluate(() => window.__ttsRequests)
      assert.equal(requests.length, 0, 'no MiMo request for an untagged reply')
      assert.equal(deepseek.length, 1)
      assert.equal(deepseek[0].text, '今天天气不错，适合出去走走。')
    }
  )

  await run(
    'role voice read-aloud: a configured MiMo voice reads untagged replies under a third-party chat model',
    async (page) => {
      await seedReply(page, '今天天气不错。', [named('d', '林黛玉')])
      await page.getByRole('button', { name: '朗读' }).first().click()
      await page.waitForFunction(() => window.__ttsRequests.length === 1)
      assert.deepEqual(await page.evaluate(() => window.__ttsRequests), [
        { voice: '白桦', text: '今天天气不错。' },
      ])
    }
  )

  // ---------- 语音合成配置（高级自定义） ----------
  await run(
    'role voice settings: the dedicated speech service can be configured separately from the chat model',
    async (page) => {
      const resolved = await page.evaluate(() => {
        const a = window.__audit
        const resolve = a.roleVoiceProfile.roleVoiceProfile
        // 1) 跟随模式：从已配置的供应商里找 MiMo
        const mimo = { id: 'p1', revision: 'r', name: '小米 MiMo', url: 'https://api.xiaomimimo.com/v1', apiKey: 'k1', protocol: 'openai', model: 'm', models: [], modelListUrl: '', headers: {}, extraBody: {}, preset: { id: 'xiaomimimo', access: 'api' } }
        const follow = resolve([mimo], { source: 'follow', providerId: null, custom: { url: '', apiKey: '', model: '' } })
        // 2) 跟随模式但没有 MiMo
        const noMimo = resolve([{ ...mimo, url: 'https://other.example/v1', preset: undefined }], { source: 'follow', providerId: null, custom: { url: '', apiKey: '', model: '' } })
        const unrelatedHost = resolve([{ ...mimo, url: 'https://other.example/v1/xiaomimimo.com', preset: undefined }], { source: 'follow', providerId: null, custom: { url: '', apiKey: '', model: '' } })
        // 3) 单独配置：不依赖供应商列表
        const custom = resolve([], { source: 'custom', providerId: null, custom: { url: ' https://tts.example/v1 ', apiKey: ' k2 ', model: 'my-tts' } })
        // 4) 单独配置但缺项
        const customMissing = resolve([], { source: 'custom', providerId: null, custom: { url: 'https://tts.example/v1', apiKey: '  ', model: '' } })
        return {
          follow: follow?.id,
          noMimo: noMimo,
          unrelatedHost,
          custom: custom && { url: custom.url, apiKey: custom.apiKey, model: custom.model, id: custom.id },
          customMissing,
        }
      })
      assert.equal(resolved.follow, 'p1', 'follow uses the configured MiMo')
      assert.equal(resolved.noMimo, null, 'follow without MiMo resolves to nothing')
      assert.equal(resolved.unrelatedHost, null)
      assert.deepEqual(resolved.custom, {
        url: 'https://tts.example/v1',
        apiKey: 'k2',
        model: 'my-tts',
        id: 'role-voice-custom',
      })
      assert.equal(resolved.customMissing, null, 'custom needs both endpoint and key')
    }
  )

  await run(
    'role voice settings: the speech page is reachable from the advanced provider settings and saves',
    async (page) => {
      await page.evaluate(() => {
        const a = window.__audit
        a.settings.setRoleVoice({
          enabled: false,
          source: 'follow',
          providerId: null,
          custom: { url: '', apiKey: '', model: '' },
        })
      })
      await page.evaluate(() => window.__audit.settingsDialog.openSettings('providers'))
      await page.waitForTimeout(500)
      const row = page.getByRole('button', { name: /语音合成/ })
      await row.waitFor({ timeout: 15000 })
      await row.click()
      await page.waitForTimeout(500)
      // 切到单独配置并填写
      const sourceSelect = page.getByRole('button', { name: '语音服务' })
      await sourceSelect.click()
      await page.getByRole('option', { name: /单独配置/ }).click()
      await page.waitForTimeout(300)
      await page.getByLabel('服务地址').fill('https://tts.example/v1')
      await page.getByLabel('API 密钥').fill('sk-speech-only')
      await page.getByLabel('预置音色模型').fill('custom-tts')
      await page.getByLabel('描述音色模型').fill('custom-design')
      assert.equal(await page.getByLabel('服务地址').getAttribute('type'), 'url')
      assert.equal(await page.getByLabel('API 密钥').getAttribute('type'), 'password')
      await page.getByRole('button', { name: '保存语音设置' }).click()
      await page.waitForTimeout(600)
      const saved = await page.evaluate(() => window.__audit.settings.useSettings.getState().roleVoice)
      assert.equal(saved.source, 'custom')
      assert.equal(saved.custom.url, 'https://tts.example/v1')
      assert.equal(saved.custom.apiKey, 'sk-speech-only')
      assert.equal(saved.custom.model, 'custom-tts')
      assert.equal(saved.custom.designModel, 'custom-design')
    }
  )
}
