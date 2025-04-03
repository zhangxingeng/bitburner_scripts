import os
from pathlib import Path
import pyperclip
import pathspec

def get_gitignore_spec(base_path):
    """Parse .gitignore file and return a pathspec object"""
    gitignore_path = Path(base_path) / '.gitignore'
    if not gitignore_path.exists():
        return None
    
    with open(gitignore_path, 'r', encoding='utf-8') as f:
        gitignore_content = f.read()
    
    return pathspec.PathSpec.from_lines(
        pathspec.patterns.GitWildMatchPattern, 
        gitignore_content.splitlines()
    )

# Common binary file extensions to skip
BINARY_EXTENSIONS = {
    # Images
    '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.tiff', '.ico', '.webp', '.svg',
    # Audio/Video
    '.mp3', '.mp4', '.wav', '.avi', '.mov', '.flv', '.mkv', '.webm',
    # Archives
    '.zip', '.tar', '.gz', '.rar', '.7z', '.bz2',
    # Executables
    '.exe', '.dll', '.so', '.dylib', '.bin',
    # Other binary
    '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
    '.class', '.pyc', '.o', '.obj',
    # Font files
    '.ttf', '.otf', '.woff', '.woff2', '.eot',
    # Lock files that can be large
    '.lockb',
}

def is_likely_binary(filepath):
    """Check if a file is likely to be binary based on extension"""
    return filepath.suffix.lower() in BINARY_EXTENSIONS

def dump_all_files(base_path):
    base_path = Path(base_path)
    output = []
    skipped_count = 0
    
    # Get gitignore patterns
    gitignore_spec = get_gitignore_spec(base_path)
    
    # Walk through all files in the directory
    for root, dirs, files in os.walk(base_path):
        # Skip hidden directories like .git
        dirs[:] = [d for d in dirs if not d.startswith('.git')]
        
        for file in files:
            filepath = Path(root) / file
            rel_path = filepath.relative_to(base_path)
            
            # Skip files ignored by gitignore
            if gitignore_spec and gitignore_spec.match_file(str(rel_path)):
                continue
            
            # Skip likely binary files
            if is_likely_binary(filepath):
                skipped_count += 1
                continue
                
            output.append(f"# file {rel_path}")
            try:
                with open(filepath, "r", encoding="utf-8") as f:
                    output.append(f.read())
            except (UnicodeDecodeError, PermissionError, IsADirectoryError):
                # Skip binary files or files that can't be read as UTF-8
                skipped_count += 1
                continue
            except Exception as e:
                output.append(f"# Could not read {filepath}: {e}")
            output.append("")  # Add a newline between files
    
    pyperclip.copy("\n".join(output))
    print(f"Dump success, content in paste bin. Skipped {skipped_count} binary/unreadable files.")


if __name__ == "__main__":
    import sys

    if len(sys.argv) != 2:
        print("Usage: python dump_code.py <directory_path>")
    else:
        dump_all_files(sys.argv[1]) 