import os
import subprocess

def build_docker(image_name, context_path):
    result = subprocess.run(
        ["docker", "build", "-t", f"mcp/{image_name}", context_path],
        check=True
    )
    return result

def main():
    current_path = os.path.dirname(os.path.abspath(__file__))
    for image_name in os.listdir(current_path):
        if not os.path.isdir(os.path.join(current_path, image_name)) or not os.path.exists(os.path.join(current_path, image_name, 'Dockerfile')):
            continue
        print(f"Building {image_name}...")
        build_docker(image_name, os.path.join(current_path, image_name))

if __name__ == "__main__":
    main()