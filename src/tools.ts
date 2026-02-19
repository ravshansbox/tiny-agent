import { promises as fs } from "fs"
import path from "path"
import { exec } from "child_process"
import { promisify } from "util"

const execAsync = promisify(exec)

type SearchMatch = {
  file: string
  line: number
  text: string
}

type RunCommandOptions = {
  cwd?: string
  env?: NodeJS.ProcessEnv
  timeout?: number
}

export const readFile = async (filePath: string) => {
  return fs.readFile(filePath, "utf8")
}

export const writeFile = async (filePath: string, content: string) => {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, content, "utf8")
}

export const editFile = async (filePath: string, oldText: string, newText: string) => {
  const content = await fs.readFile(filePath, "utf8")
  const index = content.indexOf(oldText)
  if (index === -1) {
    throw new Error("oldText not found")
  }
  const updated = content.slice(0, index) + newText + content.slice(index + oldText.length)
  await fs.writeFile(filePath, updated, "utf8")
}

export const listDir = async (dirPath = ".") => {
  const entries = await fs.readdir(dirPath, { withFileTypes: true })
  return entries.map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
}

const walk = async (dirPath: string, results: string[] = []) => {
  const entries = await fs.readdir(dirPath, { withFileTypes: true })
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name)
    if (entry.isDirectory()) {
      await walk(fullPath, results)
    } else {
      results.push(fullPath)
    }
  }
  return results
}

export const searchInFiles = async (pattern: string | RegExp, dirPath = ".") => {
  const regex = pattern instanceof RegExp ? pattern : new RegExp(pattern, "g")
  const files = await walk(dirPath)
  const matches: SearchMatch[] = []
  for (const file of files) {
    let content: string
    try {
      content = await fs.readFile(file, "utf8")
    } catch {
      continue
    }
    const lines = content.split("\n")
    lines.forEach((line, index) => {
      if (regex.test(line)) {
        matches.push({ file, line: index + 1, text: line })
      }
      regex.lastIndex = 0
    })
  }
  return matches
}

export const runCommand = async (command: string, options: RunCommandOptions = {}) => {
  const { stdout, stderr } = await execAsync(command, options)
  return { stdout, stderr }
}
