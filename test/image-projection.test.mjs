// Image projection: attached image blocks, path fallbacks, guards, keep-one-copy,
// the four-image cap, and run_plan/observe collection. Fake services only.
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { startServers, stopServers } from './fixtures/server-harness.mjs'

const IMAGE_SERVER = fileURLToPath(
  new URL('./fixtures/fake-image-server.mjs', import.meta.url),
)

function imageContext(options = {}) {
  const saved = []
  const resolved = []
  const attachments = options.attachments === null ? undefined : {
    async saveImages(inputs) {
      saved.push(...inputs)
      return inputs.map((input) => ({
        attachmentId: input.data.toString('base64'),
        mediaType: input.mediaType,
      }))
    },
    ...options.attachments,
  }
  const llm = {
    async resolveModelInfo() {
      resolved.push(true)
      if (options.resolveThrows === true) throw new Error('route lookup failed')
      return { inputModalities: options.modalities ?? ['text', 'image'] }
    },
  }
  const services = {}
  if (attachments !== undefined) services.attachments = attachments
  services.llm = llm
  const config = { computer: options.computer ?? false }
  if (Object.hasOwn(options, 'attachImages')) config.attachImages = options.attachImages
  if (Object.hasOwn(options, 'keepImageFiles')) config.keepImageFiles = options.keepImageFiles
  const context = startServers({
    browser: { server: IMAGE_SERVER, mode: options.mode ?? 'one' },
    desktop: options.desktop === false ? false : {
      server: IMAGE_SERVER, mode: options.mode ?? 'one',
    },
    config: { ...config, ...options.config },
    services: options.services ?? services,
  })
  return { context, saved, resolved }
}

function execFor(name = 'pc_codex_js', signal = new AbortController().signal) {
  return {
    name,
    callId: 'image-call',
    signal,
    agent: {
      id: 'image-agent',
      session: {
        id: 'image-session',
        requestHeader: () => ({ config: { provider: 'image-provider', model: 'image-model' } }),
      },
      options: { provider: 'image-provider', model: 'image-model' },
    },
  }
}

function assertNoMarkers(value) {
  assert.equal(value.includes('\u0000'), false)
}

function project(tool, exec, value) {
  return tool.projectContent(exec, {
    value,
    content: tool.output.render(undefined, value),
    isError: false,
  })
}

function close(context) {
  return stopServers(context)
}

test('an image-capable model gets text plus one image block and no local copy', async () => {
  const { context, saved } = imageContext()
  try {
    const tool = context.plugin.tools.get('pc_codex_js')
    const exec = execFor()
    const value = await tool.execute({ code: '1', title: 'one image' }, exec)
    assert.match(value, /^Wall time: \d+\.\d{4} seconds\nOutput:\n/)
    assert.match(value, /\[image 1: image\/png, attached\]/)
    assertNoMarkers(value)
    assert.equal(value.includes('.dsh'), false)
    const content = project(tool, exec, value)
    assert.equal(content[0].type, 'text')
    assert.equal(content[0].text, value)
    assert.equal(content[1].type, 'image')
    assert.equal(content[1].attachment.attachmentId,
      Buffer.from('png-1').toString('base64'))
    assert.equal(saved.length, 1)
    assert.equal(existsSync(join(context.home, '.dsh', 'pc-use-images')), false)
    assert.equal(project(tool, exec, value), undefined)
  } finally {
    assert.equal(await close(context), true)
  }
})

test('fallback reasons cover modality, store, route, save failure and cancellation', async () => {
  const cases = [
    { options: { modalities: ['text'] }, reason: 'model has no image input' },
    { options: { attachments: null }, reason: 'no attachment store' },
    { options: { resolveThrows: true }, reason: 'model route unknown' },
    {
      options: {
        services: {
          attachments: {
            async saveImages() { throw new Error('disk full') },
          },
          llm: { async resolveModelInfo() { return { inputModalities: ['image'] } } },
        },
      },
      reason: 'attachment store rejected the images',
    },
  ]
  for (const { options, reason } of cases) {
    const { context } = imageContext(options)
    try {
      const tool = context.plugin.tools.get('pc_codex_js')
      const exec = execFor()
      const value = await tool.execute({ code: '1', title: 'fallback' }, exec)
      assertNoMarkers(value)
      assert.match(value, /\[image saved: /, reason)
      assert.match(value, new RegExp(`not attached: ${reason}`), reason)
      assert.equal(project(tool, exec, value), undefined)
      assert.match(readFileSync(context.logFile, 'utf8'),
        new RegExp(`image projection fallback: ${reason}`))
    } finally {
      assert.equal(await close(context), true)
    }
  }
  const { context } = imageContext()
  try {
    const tool = context.plugin.tools.get('pc_codex_js')
    const controller = new AbortController()
    controller.abort()
    const value = await tool.execute({ code: '1', title: 'aborted' }, execFor(
      'pc_codex_js', controller.signal,
    ))
    assert.match(value, /not attached: call canceled/)
    assert.match(readFileSync(context.logFile, 'utf8'),
      /image projection fallback: call canceled/)
  } finally {
    assert.equal(await close(context), true)
  }
})

test('attachImages false skips route and attachment work', async () => {
  const { context, saved, resolved } = imageContext({ attachImages: false })
  try {
    const tool = context.plugin.tools.get('pc_codex_js')
    const exec = execFor()
    const value = await tool.execute({ code: '1', title: 'off' }, exec)
    assertNoMarkers(value)
    assert.match(value, /not attached: attachImages is off/)
    assert.match(readFileSync(context.logFile, 'utf8'),
      /image projection fallback: attachImages is off/)
    assert.equal(resolved.length, 0)
    assert.equal(saved.length, 0)
    assert.equal(project(tool, exec, value), undefined)
  } finally {
    assert.equal(await close(context), true)
  }
})

test('keepImageFiles true saves attached images locally and says so', async () => {
  const { context } = imageContext({ keepImageFiles: true })
  try {
    const tool = context.plugin.tools.get('pc_codex_js')
    const value = await tool.execute({ code: '1', title: 'keep' }, execFor())
    assertNoMarkers(value)
    const match = /attached; saved: (.+)\]/.exec(value)
    assert.ok(match, value)
    assert.equal(existsSync(match[1]), true)
  } finally {
    assert.equal(await close(context), true)
  }
})

test('projectContent refuses errors, changed values/content and second use', async () => {
  const { context } = imageContext()
  try {
    const tool = context.plugin.tools.get('pc_codex_js')
    const errorExec = execFor()
    const errorValue = await tool.execute({ code: '1', title: 'error guard' }, errorExec)
    const errorContent = tool.output.render(undefined, errorValue)
    assert.equal(tool.projectContent(errorExec, {
      value: errorValue, content: errorContent, isError: true,
    }), undefined)

    const valueExec = execFor()
    const value = await tool.execute({ code: '1', title: 'value guard' }, valueExec)
    assert.equal(tool.projectContent(valueExec, {
      value: `${value} changed`,
      content: tool.output.render(undefined, value),
      isError: false,
    }), undefined)

    const contentExec = execFor()
    const contentValue = await tool.execute({ code: '1', title: 'content guard' }, contentExec)
    assert.equal(tool.projectContent(contentExec, {
      value: contentValue,
      content: [{ type: 'text', text: 'changed' }],
      isError: false,
    }), undefined)

    const twiceExec = execFor()
    const twice = await tool.execute({ code: '1', title: 'twice' }, twiceExec)
    const twiceContent = tool.output.render(undefined, twice)
    assert.notEqual(tool.projectContent(twiceExec, {
      value: twice, content: twiceContent, isError: false,
    }), undefined)
    assert.equal(tool.projectContent(twiceExec, {
      value: twice, content: twiceContent, isError: false,
    }), undefined)
  } finally {
    assert.equal(await close(context), true)
  }
})

test('invalid image data rejects the whole batch', async () => {
  for (const mode of ['bad-mime', 'bad-base64', 'bad-mixed']) {
    const { context, saved } = imageContext({ mode })
    try {
      const tool = context.plugin.tools.get('pc_codex_js')
      const exec = execFor()
      const value = await tool.execute({ code: '1', title: 'bad' }, exec)
      assertNoMarkers(value)
      assert.match(value, /not attached: unsupported image data/, mode)
      assert.equal(project(tool, exec, value), undefined)
      assert.equal(saved.length, 0)
    } finally {
      assert.equal(await close(context), true)
    }
  }
})

test('six images attach the last four and save the first two as fallbacks', async () => {
  const { context, saved } = imageContext({ mode: 'six' })
  try {
    const tool = context.plugin.tools.get('pc_codex_js')
    const exec = execFor()
    const value = await tool.execute({ code: '1', title: 'six' }, exec)
    assertNoMarkers(value)
    for (const index of [1, 2]) {
      assert.match(value, new RegExp(`\\[image ${index} not attached: more than 4`))
    }
    for (const index of [3, 4, 5, 6]) {
      assert.match(value, new RegExp(`\\[image ${index}: image/png, attached\\]`))
    }
    const firstSaved = value.indexOf('[image saved:')
    const secondSaved = value.indexOf('[image saved:', firstSaved + 1)
    assert.ok(firstSaved >= 0 && secondSaved > firstSaved)
    const expected = [3, 4, 5, 6].map((index) => (
      Buffer.from(`png-${index}`).toString('base64')
    ))
    assert.deepEqual(saved.map((input) => input.data.toString('base64')), expected)
    const projected = project(tool, exec, value)
    assert.equal(projected.filter((part) => part.type === 'image').length, 4)
    assert.deepEqual(
      projected.filter((part) => part.type === 'image').map((part) => part.attachment.attachmentId),
      expected,
    )
  } finally {
    assert.equal(await close(context), true)
  }
})

test('desktop js also projects images through the desktop registration', async () => {
  const { context } = imageContext({ computer: true })
  try {
    const tool = context.plugin.tools.get('pc_codex_desktop_js')
    const exec = execFor('pc_codex_desktop_js')
    const value = await tool.execute({ code: '1', title: 'desktop image' }, exec)
    assert.match(value, /\[image 1: image\/png, attached\]/)
    assertNoMarkers(value)
    assert.equal(project(tool, exec, value).filter((part) => part.type === 'image').length, 1)
  } finally {
    assert.equal(await close(context), true)
  }
})

test('defaults attach images and do not keep a local copy', async () => {
  const { context } = imageContext()
  try {
    const tool = context.plugin.tools.get('pc_codex_js')
    const value = await tool.execute({ code: '1', title: 'defaults' }, execFor())
    assertNoMarkers(value)
    assert.match(value, /\[image 1: image\/png, attached\]/)
    assert.equal(value.includes('saved:'), false)
    assert.equal(existsSync(join(context.home, '.dsh', 'pc-use-images')), false)
  } finally {
    assert.equal(await close(context), true)
  }
})

test('keepImageFiles local save failure is stated in the placeholder', async () => {
  const { context } = imageContext({ keepImageFiles: true })
  try {
    writeFileSync(join(context.home, '.dsh'), 'not a directory')
    const tool = context.plugin.tools.get('pc_codex_js')
    const value = await tool.execute({ code: '1', title: 'keep failure' }, execFor())
    assertNoMarkers(value)
    assert.match(value, /\[image 1: image\/png, attached; could not be saved\]/)
  } finally {
    assert.equal(await close(context), true)
  }
})

test('error results keep image paths and never project', async () => {
  const { context } = imageContext({ mode: 'error-image' })
  try {
    const tool = context.plugin.tools.get('pc_codex_js')
    const exec = execFor()
    await assert.rejects(
      tool.execute({ code: '1', title: 'error image' }, exec),
      (error) => {
        assert.match(error.message, /\[image saved: /)
        assertNoMarkers(error.message)
        assert.equal(error.message.includes('attached'), false)
        return true
      },
    )
    assert.equal(tool.projectContent(exec, {
      value: 'error', content: [], isError: true,
    }), undefined)
  } finally {
    assert.equal(await close(context), true)
  }
})

test('run_plan failure after an image saves a path fallback without markers', async () => {
  const { context } = imageContext()
  try {
    const tool = context.plugin.tools.get('pc_codex_run_plan')
    const exec = execFor('pc_codex_run_plan')
    await assert.rejects(
      tool.execute({
        target: 'browser',
        steps: [
          { title: 'image', code: '1' },
          { title: 'fail', code: 'STEP_FAIL' },
        ],
      }, exec),
      (error) => {
        assert.match(error.message, /\[image saved: /)
        assert.match(error.message, /not attached: tool call failed/)
        assertNoMarkers(error.message)
        return true
      },
    )
    assert.equal(tool.projectContent(exec, {
      value: 'error', content: [], isError: true,
    }), undefined)
    assert.match(readFileSync(context.logFile, 'utf8'),
      /image projection fallback: tool call failed/)
  } finally {
    assert.equal(await close(context), true)
  }
})

test('page text containing the old marker format is not replaced', async () => {
  const { context } = imageContext({ mode: 'old-marker' })
  try {
    const tool = context.plugin.tools.get('pc_codex_js')
    const value = await tool.execute({ code: '1', title: 'old marker' }, execFor())
    assert.match(value, /\[image 1: image\/png, attached\]/)
    assert.equal(value.includes('\u0000pc-image:0\u0000'), true)
  } finally {
    assert.equal(await close(context), true)
  }
})

test('run_plan and observe collect images in call order', async () => {
  const { context } = imageContext({ mode: 'one' })
  try {
    const plan = context.plugin.tools.get('pc_codex_run_plan')
    const planExec = execFor('pc_codex_run_plan')
    const text = await plan.execute({
      target: 'browser',
      steps: [
        { title: 'one', code: '1' },
        { title: 'two', code: '2' },
      ],
      observe: { subject: 'tab' },
    }, planExec)
    assert.match(text, /\[image 1: image\/png, attached\]/)
    assert.match(text, /\[image 2: image\/png, attached\]/)
    assert.match(text, /\[image 3: image\/png, attached\]/)
    assertNoMarkers(text)
    const projected = project(plan, planExec, text)
    assert.equal(projected.filter((part) => part.type === 'image').length, 3)
    const observe = context.plugin.tools.get('pc_codex_observe')
    const observeExec = execFor('pc_codex_observe')
    const observed = await observe.execute({ target: 'browser', subject: 'tab' }, observeExec)
    assert.match(observed, /\[image 1: image\/png, attached\]/)
    assertNoMarkers(observed)
    assert.equal(project(observe, observeExec, observed).filter(
      (part) => part.type === 'image').length, 1)
  } finally {
    assert.equal(await close(context), true)
  }
})
